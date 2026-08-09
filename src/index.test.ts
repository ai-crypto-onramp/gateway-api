import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildServer, type AppHandle } from "./index.js";
import { NoopLimiter } from "./rate-limit/limiter.js";
import { createMetrics } from "./observability/metrics.js";
import { createTracing } from "./observability/tracing.js";
import type { AppConfig } from "./config.js";
import { DEFAULT_TEST_ENV, loadConfig } from "./config.js";
import { makeTestJwtVerifier } from "./test-helpers/jwt.js";
function testConfig(): AppConfig {
  return loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "test", RATE_LIMIT_REDIS_URL: "", OTEL_EXPORTER_OTLP_ENDPOINT: "" });
}

async function build(handle?: Partial<Parameters<typeof buildServer>[0]>): Promise<AppHandle> {
  return buildServer({
    config: testConfig(),
    metrics: createMetrics("api-gateway-test"),
    tracing: createTracing(testConfig()),
    limiter: NoopLimiter.instance,
    ...handle,
  });
}

describe("healthz & readyz", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.shutdown();
  });
  it("healthz returns ok", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
  it("readyz returns ok with checks", async () => {
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("auth session", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("rejects invalid body 400", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/auth/session", payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("invalid_request");
  });
  it("returns session for refresh_token", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { grantType: "refresh_token", refreshToken: "r1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenType).toBe("Bearer");
  });
});

describe("quotes", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("rejects invalid body when authenticated", async () => {
    const { verifier, token } = await makeTestJwtVerifier();
    const h2 = await build({ jwtVerifier: verifier });
    try {
      const res = await h2.app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await h2.shutdown();
    }
  });
  it("requires auth (mocked jwtAuth requires bearer)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/quotes",
      payload: { baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "100", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("transactions", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("requires auth on initiate", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/transactions",
      payload: { quoteId: "q1", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(401);
  });
  it("requires auth on get", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/transactions/tx1" });
    expect(res.statusCode).toBe(401);
  });
  it("requires auth on list", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/transactions" });
    expect(res.statusCode).toBe(401);
  });
});

describe("kyc", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("kyc/start rejects invalid body when authenticated", async () => {
    const { verifier, token } = await makeTestJwtVerifier();
    const h2 = await build({ jwtVerifier: verifier });
    try {
      const res = await h2.app.inject({
        method: "POST",
        url: "/v1/kyc/start",
        headers: { authorization: `Bearer ${token}` },
        payload: { flow: "bogus" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await h2.shutdown();
    }
  });
  it("kyc/status requires auth", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/kyc/status" });
    expect(res.statusCode).toBe(401);
  });
});

describe("partner webhooks", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("rejects invalid body", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/partner/webhooks", payload: { url: "bad" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("metrics endpoint", () => {
  it("exposes prometheus metrics", async () => {
    const h = await build();
    try {
      const res = await h.app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("http_requests_total");
    } finally {
      await h.shutdown();
    }
  });
});

describe("version negotiation & headers", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("emits security headers", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["strict-transport-security"]).toContain("max-age");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
  it("rejects unsupported x-api-version", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz", headers: { "x-api-version": "9" } });
    expect(res.statusCode).toBe(400);
  });
  it("accepts x-api-version 1", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz", headers: { "x-api-version": "1" } });
    expect(res.statusCode).toBe(200);
  });
  it("accepts x-api-version 2 with sunset header", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz", headers: { "x-api-version": "2" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["sunset"]).toContain("2099");
    expect(res.headers["link"]).toContain("successor-version");
  });
  it("returns x-request-id", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
  it("preserves provided x-request-id", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "abc-123" } });
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });
  it("handles CORS preflight", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });
  it("CORS ignores unknown origin", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("start", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("listens on the PORT env var", async () => {
    const h = await build();
    try {
      h.app.listen = vi.fn(async () => h.app) as never;
      startHandle(h, 0);
      await vi.waitFor(() => expect((h.app.listen as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
      expect((h.app.listen as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ port: 0, host: "0.0.0.0" });
    } finally {
      await h.shutdown();
    }
  });
  it("start() calls listen and exits on failure", async () => {
    const h = await build();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    h.app.listen = vi.fn(async () => h.app) as never;
    (h.app.listen as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("bind") as never);
    const { start } = await import("./index.js");
    start(h, 0);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    vi.restoreAllMocks();
  });
  it("main() builds and starts", async () => {
    const cfg = testConfig();
    vi.stubEnv("NODE_ENV", "test");
    const h = await buildServer({ config: cfg, metrics: createMetrics("t"), tracing: createTracing(cfg), limiter: NoopLimiter.instance });
    h.app.listen = vi.fn(async () => h.app) as never;
    const { start } = await import("./index.js");
    start(h, 0);
    await vi.waitFor(() => expect((h.app.listen as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    await h.shutdown();
  });
});

describe("shutdown", () => {
  it("closes app and tracing", async () => {
    const h = await build();
    const closeSpy = vi.spyOn(h.app, "close");
    await h.shutdown();
    expect(closeSpy).toHaveBeenCalled();
  });
  it("installSignalHandlers registers SIGTERM/SIGINT", async () => {
    const h = await build();
    const before = process.listenerCount("SIGTERM");
    h.installSignalHandlers();
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(before);
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    await h.shutdown();
  });
});

describe("real http clients path", () => {
  it("uses createHttpClients when not test env and redis url set", async () => {
    const cfg = loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "production", RATE_LIMIT_REDIS_URL: "redis://x", OTEL_EXPORTER_OTLP_ENDPOINT: "", IDENTITY_AUTH_URL: "http://127.0.0.1:1", KYC_URL: "http://127.0.0.1:1", PRICING_URL: "http://127.0.0.1:1", ORCHESTRATOR_URL: "http://127.0.0.1:1" });
    const h = await buildServer({ config: cfg, metrics: createMetrics("t"), tracing: createTracing(cfg), limiter: NoopLimiter.instance });
    expect(h.httpClients).toBeDefined();
    expect(typeof h.clients.identityAuth.exchangeSession).toBe("function");
    await h.shutdown();
  });
});

function startHandle(h: AppHandle, port: number) {
  h.app.listen({ port, host: "0.0.0.0" }).catch(() => undefined);
}