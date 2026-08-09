import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer, type AppHandle } from "../index.js";
import { createMetrics } from "../observability/metrics.js";
import { createTracing } from "../observability/tracing.js";
import { NoopLimiter } from "../rate-limit/limiter.js";
import { createMockClients } from "../clients/mock.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";
import { makeTestJwtVerifier, makeExpiredTokenVerifier } from "../test-helpers/jwt.js";

async function build(extra: Partial<Parameters<typeof buildServer>[0]> = {}): Promise<AppHandle> {
  const cfg = loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "test", RATE_LIMIT_REDIS_URL: "", OTEL_EXPORTER_OTLP_ENDPOINT: "" });
  return buildServer({
    config: cfg,
    metrics: createMetrics("api-gateway-test"),
    tracing: createTracing(cfg),
    limiter: NoopLimiter.instance,
    ...extra,
  });
}

describe("authenticated routes", () => {
  let h: AppHandle;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    const { verifier, token: t, userId: u } = await makeTestJwtVerifier();
    token = t;
    userId = u;
    h = await build({ jwtVerifier: verifier });
  });

  afterEach(async () => {
    await h.shutdown();
  });

  it("GET /v1/me returns aggregated profile + kyc", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.userId).toBe(userId);
    expect(body.kyc.userId).toBe(userId);
    expect(body.kyc.status).toBeDefined();
  });

  it("POST /v1/quotes returns 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { authorization: `Bearer ${token}` },
      payload: { baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "100.00", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().quoteId).toBeTruthy();
  });

  it("POST /v1/transactions returns 201 with idempotency-key", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "ik-1" },
      payload: { quoteId: "q1", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["idempotency-key"]).toBe("ik-1");
    expect(res.json().transactionId).toBeTruthy();
  });

  it("GET /v1/transactions/:id returns shaped status", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/transactions/tx1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionId).toBe("tx1");
  });

  it("GET /v1/transactions returns paginated list", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/transactions?limit=10",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
    expect(res.json().pagination.limit).toBe(10);
  });

  it("POST /v1/kyc/start returns 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/kyc/start",
      headers: { authorization: `Bearer ${token}` },
      payload: { flow: "standard" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().referenceId).toBeTruthy();
  });

  it("GET /v1/kyc/status returns status", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/kyc/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBeDefined();
  });
});

describe("auth failures", () => {
  it("rejects expired token with 401", async () => {
    const { verifier, token } = await makeExpiredTokenVerifier();
    const h = await build({ jwtVerifier: verifier });
    try {
      const res = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.shutdown();
    }
  });

  it("rejects missing scopes with 403", async () => {
    const { verifier, token } = await makeTestJwtVerifier(["me:read"]);
    const h = await build({ jwtVerifier: verifier });
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { authorization: `Bearer ${token}` },
        payload: { baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "1", paymentMethod: "card" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("forbidden");
    } finally {
      await h.shutdown();
    }
  });

  it("rejects malformed bearer header", async () => {
    const h = await build();
    try {
      const res = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer" } });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.shutdown();
    }
  });
});

describe("partner webhooks authenticated", () => {
  it("registers a webhook with valid API key", async () => {
    const clients = createMockClients({
      apiKeys: { "pkey-1": { partnerId: "p1", identity: "partner-1" } },
    });
    const h = await build({ clients });
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/partner/webhooks",
        headers: { "X-API-Key": "pkey-1" },
        payload: { url: "https://partner.example.com/hooks", events: ["transaction.completed"] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().webhookId).toBeTruthy();
    } finally {
      await h.shutdown();
    }
  });

  it("rejects invalid API key", async () => {
    const clients = createMockClients({ apiKeys: {} });
    const h = await build({ clients });
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/partner/webhooks",
        headers: { "X-API-Key": "bad" },
        payload: { url: "https://partner.example.com/hooks", events: ["transaction.completed"] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.shutdown();
    }
  });
});