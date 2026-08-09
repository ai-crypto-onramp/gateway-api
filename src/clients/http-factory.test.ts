import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHttpClients, type HttpClientFactory } from "./http-factory.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import type { OrchestratorSagaState } from "../domain/status-mapping.js";

function cfg(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({ ...DEFAULT_TEST_ENV, DOWNSTREAM_TIMEOUT_MS: "300", ...overrides });
}

function startServer(handler: (req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> }, res: { writeHead: (s: number, h?: Record<string, string>) => void; end: (b: string) => void }) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer((req, res) => handler(req as never, res as never));
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

describe("http-factory adapters", () => {
  let srv: { url: string; close: () => Promise<void> } | undefined;
  let clients: HttpClientFactory | undefined;
  afterEach(async () => {
    if (srv) await srv.close();
    srv = undefined;
    clients = undefined;
  });

  it("identityAuth.exchangeSession posts to /v1/sessions", async () => {
    srv = await startServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/sessions");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 3600 }));
    });
    const c = cfg({ IDENTITY_AUTH_URL: srv.url });
    clients = createHttpClients({ config: c, tokenProvider: () => "t", traceProvider: () => ({}) });
    const r = await clients.identityAuth.exchangeSession({ grantType: "refresh_token", refreshToken: "x" });
    expect(r.accessToken).toBe("a");
    expect(clients.states().find((s) => s.service === "identity-auth")?.state).toBe("closed");
  });

  it("kyc.getStatus maps and returns", async () => {
    srv = await startServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/v1/kyc/u1");
      res.writeHead(200);
      res.end(JSON.stringify({ userId: "u1", status: "pending" }));
    });
    const c = cfg({ KYC_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.kyc.getStatus("u1");
    expect(r.status).toBe("pending");
  });

  it("kyc.start posts body", async () => {
    srv = await startServer((req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ referenceId: "k1", status: "pending", createdAt: "2024-01-01T00:00:00Z" }));
    });
    const c = cfg({ KYC_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.kyc.start("u1", { flow: "standard" });
    expect(r.referenceId).toBe("k1");
  });

  it("pricing.createQuote forwards", async () => {
    srv = await startServer((req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({
        quoteId: "q1", baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "100", quoteAmount: "0.05",
        rate: "0.0005", expiresAt: "2024-01-01T00:00:00Z", paymentMethod: "card",
        fees: { network: "1", partner: "0", total: "1" },
      }));
    });
    const c = cfg({ PRICING_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.pricing.createQuote({ baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "100", paymentMethod: "card" });
    expect(r.quoteId).toBe("q1");
  });

  it("orchestrator.initiate forwards idempotency key header", async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    srv = await startServer((req, res) => {
      seenHeaders = req.headers ?? {};
      res.writeHead(200);
      res.end(JSON.stringify({ transactionId: "t1", status: "pending_payment", quoteId: "q1", createdAt: "2024-01-01T00:00:00Z" }));
    });
    const c = cfg({ ORCHESTRATOR_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.orchestrator.initiate({ quoteId: "q1", paymentMethod: "card", idempotencyKey: "ik-1", userId: "u1" });
    expect(r.transactionId).toBe("t1");
    expect(seenHeaders["idempotency-key"]).toBe("ik-1");
  });

  it("orchestrator.getTransaction maps saga state to client status", async () => {
    srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ sagaState: "SETTLED", transactionId: "t1", createdAt: "2024-01-01T00:00:00Z", ledger: { debited: true } }));
    });
    const c = cfg({ ORCHESTRATOR_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.orchestrator.getTransaction("t1");
    expect(r.status).toBe("completed");
    expect(r.sagaState).toBe("SETTLED" as OrchestratorSagaState);
    expect(r.ledger?.debited).toBe(true);
    expect(r.failureReason).toBeUndefined();
  });

  it("orchestrator.getTransaction maps failure saga states", async () => {
    srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ sagaState: "PAYMENT_FAILED", transactionId: "t2", createdAt: "2024-01-01T00:00:00Z" }));
    });
    const c = cfg({ ORCHESTRATOR_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.orchestrator.getTransaction("t2");
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("payment_failed");
  });

  it("orchestrator.listTransactions forwards cursor + userId header", async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    let seenUrl: string | undefined;
    srv = await startServer((req, res) => {
      seenHeaders = req.headers ?? {};
      seenUrl = req.url;
      res.writeHead(200);
      res.end(JSON.stringify({ items: [], pagination: { cursor: null, hasNext: false, limit: 20 } }));
    });
    const c = cfg({ ORCHESTRATOR_URL: srv.url });
    clients = createHttpClients({ config: c });
    await clients.orchestrator.listTransactions("u1", { limit: 20, cursor: "c1" });
    expect(seenUrl).toContain("cursor=c1");
    expect(seenHeaders["x-user-id"]).toBe("u1");
  });

  it("partnerRegistry.registerWebhook forwards partner id header", async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    srv = await startServer((req, res) => {
      seenHeaders = req.headers ?? {};
      res.writeHead(200);
      res.end(JSON.stringify({ webhookId: "w1", url: "https://x.com", events: ["transaction.completed"], createdAt: "2024-01-01T00:00:00Z" }));
    });
    const c = cfg({ IDENTITY_AUTH_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.partnerRegistry.registerWebhook("p1", { url: "https://x.com", events: ["transaction.completed"] });
    expect(r.webhookId).toBe("w1");
    expect(seenHeaders["x-partner-id"]).toBe("p1");
  });

  it("partnerRegistry.verifyApiKey returns null on downstream error", async () => {
    srv = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const c = cfg({ IDENTITY_AUTH_URL: srv.url });
    clients = createHttpClients({ config: c });
    const r = await clients.partnerRegistry.verifyApiKey("bad");
    expect(r).toBeNull();
  });

  it("tokenProvider is awaited and injected", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    srv = await startServer((req, res) => {
      seen = req.headers ?? {};
      res.writeHead(200);
      res.end(JSON.stringify({ accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 1 }));
    });
    const c = cfg({ IDENTITY_AUTH_URL: srv.url });
    clients = createHttpClients({
      config: c,
      tokenProvider: async () => "async-tok",
      traceProvider: () => ({ traceparent: "00-x-x-01" }),
    });
    await clients.identityAuth.exchangeSession({ grantType: "refresh_token", refreshToken: "r" });
    expect(seen["x-internal-token"]).toBe("async-tok");
    expect(seen["traceparent"]).toBe("00-x-x-01");
  });

  it("caches profile reads (graceful degradation on circuit open)", async () => {
    let calls = 0;
    srv = await startServer((_req, res) => {
      calls++;
      if (calls <= 1) {
        res.writeHead(200);
        res.end(JSON.stringify({ userId: "u1" }));
      } else {
        res.writeHead(500);
        res.end("boom");
      }
    });
    const c = cfg({ IDENTITY_AUTH_URL: srv.url, CIRCUIT_BREAKER_THRESHOLD: "1" });
    const cache = {
      store: new Map<string, unknown>(),
      async get<T>(k: string): Promise<T | undefined> {
        return this.store.get(k) as T | undefined;
      },
      async set<T>(k: string, v: T): Promise<void> {
        this.store.set(k, v);
      },
    };
    clients = createHttpClients({ config: c, cache });
    await clients.identityAuth.getProfile("u1");
    let cachedHits = 0;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await clients.identityAuth.getProfile("u1");
        void r;
        cachedHits++;
      } catch {
        // ignore
      }
    }
    expect(cachedHits).toBeGreaterThan(0);
  });
});