import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { DownstreamClient, DownstreamError } from "./downstream.js";
import type { AppConfig } from "../config.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";

function cfg(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({ ...DEFAULT_TEST_ENV, DOWNSTREAM_TIMEOUT_MS: "200", CIRCUIT_BREAKER_THRESHOLD: "50", ...overrides });
}

function startServer(handler: (req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b: string) => void }) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer((req, res) => handler(req as never, res as never));
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

describe("DownstreamClient", () => {
  let servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  it("performs a successful request", async () => {
    const s = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    servers.push(s);
    const dc = new DownstreamClient({ service: "test", baseUrl: s.url, config: cfg() });
    const r = await dc.request<{ ok: boolean }>({ method: "GET", path: "/foo", idempotent: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, path: "/foo" });
  });

  it("maps 5xx to DownstreamError", async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    servers.push(s);
    const dc = new DownstreamClient({ service: "test", baseUrl: s.url, config: cfg() });
    await expect(dc.request({ method: "GET", path: "/", idempotent: false })).rejects.toThrow(/500/);
  });

  it("retries idempotent calls on 5xx", async () => {
    let calls = 0;
    const s = await startServer((_req, res) => {
      calls++;
      res.writeHead(500);
      res.end("boom");
    });
    servers.push(s);
    const dc = new DownstreamClient({ service: "test", baseUrl: s.url, config: cfg(), maxRetries: 2 });
    await expect(dc.request({ method: "GET", path: "/", idempotent: true })).rejects.toBeInstanceOf(DownstreamError);
    expect(calls).toBe(3);
  });

  it("does not retry non-idempotent calls", async () => {
    let calls = 0;
    const s = await startServer((_req, res) => {
      calls++;
      res.writeHead(500);
      res.end("boom");
    });
    servers.push(s);
    const dc = new DownstreamClient({ service: "test", baseUrl: s.url, config: cfg(), maxRetries: 3 });
    await expect(dc.request({ method: "POST", path: "/", idempotent: false })).rejects.toBeInstanceOf(DownstreamError);
    expect(calls).toBe(1);
  });

  it("injects tracecontext + internal token headers", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const s = await startServer((req, res) => {
      seen = req.headers as never;
      res.writeHead(200);
      res.end("{}");
    });
    servers.push(s);
    const dc = new DownstreamClient({
      service: "test",
      baseUrl: s.url,
      config: cfg(),
      tokenProvider: () => "tok-1",
      traceProvider: () => ({ traceparent: "00-0-0-01" }),
    });
    await dc.request({ method: "GET", path: "/", idempotent: true });
    expect(seen["x-internal-token"]).toBe("tok-1");
    expect(seen["traceparent"]).toBe("00-0-0-01");
  });

  it("returns cached fallback when circuit opens after failures", async () => {
    const cache = {
      store: new Map<string, unknown>(),
      async get<T>(k: string): Promise<T | undefined> {
        return this.store.get(k) as T | undefined;
      },
      async set<T>(k: string, v: T): Promise<void> {
        this.store.set(k, v);
      },
    };
    const s = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    servers.push(s);
    const dc = new DownstreamClient({
      service: "test",
      baseUrl: s.url,
      config: cfg({ CIRCUIT_BREAKER_THRESHOLD: "1" }),
      cache,
      cacheTtlMs: 60_000,
      bulkhead: 1,
    });
    const goodKey = "cache:good";
    await cache.set(goodKey, { cached: true });
    let rejected = 0;
    let cachedHits = 0;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await dc.request<{ cached?: boolean }>({ method: "GET", path: "/", idempotent: true, cacheKey: goodKey });
        if (res.cached) cachedHits++;
      } catch {
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(0);
    expect(cachedHits).toBeGreaterThan(0);
  });
});