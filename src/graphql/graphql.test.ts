import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer, type AppHandle } from "../index.js";
import { createMetrics } from "../observability/metrics.js";
import { createTracing } from "../observability/tracing.js";
import { NoopLimiter } from "../rate-limit/limiter.js";
import { createMockClients } from "../clients/mock.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";
import { makeTestJwtVerifier } from "../test-helpers/jwt.js";

async function build(): Promise<AppHandle> {
  const cfg = loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "test", RATE_LIMIT_REDIS_URL: "", OTEL_EXPORTER_OTLP_ENDPOINT: "", ENABLE_GRAPHQL: "true" });
  return buildServer({
    config: cfg,
    metrics: createMetrics("api-gateway-test"),
    tracing: createTracing(cfg),
    limiter: NoopLimiter.instance,
    clients: createMockClients({
      kyc: { "user-test-1": { status: "approved", referenceId: "k1" } },
      apiKeys: { "pkey-1": { partnerId: "p1", identity: "partner-1" } },
    }),
  });
}

describe("graphql", () => {
  let h: AppHandle;
  let token: string;
  beforeEach(async () => {
    const { verifier, token: t } = await makeTestJwtVerifier();
    token = t;
    h = await build();
    // override jwtVerifier after the fact via decorator is not possible; rebuild with verifier
    await h.shutdown();
    const cfg = loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "test", RATE_LIMIT_REDIS_URL: "", OTEL_EXPORTER_OTLP_ENDPOINT: "", ENABLE_GRAPHQL: "true" });
    h = await buildServer({
      config: cfg,
      metrics: createMetrics("api-gateway-test"),
      tracing: createTracing(cfg),
      limiter: NoopLimiter.instance,
      jwtVerifier: verifier,
      clients: createMockClients({
        kyc: { "user-test-1": { status: "approved", referenceId: "k1" } },
        apiKeys: { "pkey-1": { partnerId: "p1", identity: "partner-1" } },
      }),
    });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it("responds to me query with auth", async () => {
    const query = `{ me { user { userId } kyc { status } } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.me.user.userId).toBe("user-test-1");
    expect(body.data.me.kyc.status).toBe("approved");
  });

  it("returns transactions list", async () => {
    const query = `{ transactions(limit: 5) { items { transactionId } pagination { limit hasNext } } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data.transactions.items)).toBe(true);
    expect(body.data.transactions.pagination.limit).toBe(5);
  });

  it("createQuote mutation returns a quote", async () => {
    const query = `mutation { createQuote(input: { baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "100", paymentMethod: "card" }) { quoteId rate } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.createQuote.quoteId).toBeTruthy();
  });

  it("initiateTransaction mutation returns a transaction", async () => {
    const query = `mutation { initiateTransaction(input: { quoteId: "q1", paymentMethod: "card" }, idempotencyKey: "ik-1") { transactionId status } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.initiateTransaction.transactionId).toBeTruthy();
  });

  it("startKyc mutation returns kyc status", async () => {
    const query = `mutation { startKyc(flow: "standard") { referenceId status } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.startKyc.referenceId).toBeTruthy();
  });

  it("transaction query returns a transaction", async () => {
    const query = `{ transaction(id: "tx1") { transactionId status } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.transaction.transactionId).toBe("tx1");
  });

  it("kycStatus query returns status", async () => {
    const query = `{ kycStatus { userId status } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.kycStatus.userId).toBe("user-test-1");
  });

  it("rejects unauthenticated graphql", async () => {
    const query = `{ me { user { userId } } }`;
    const res = await h.app.inject({
      method: "POST",
      url: "/graphql",
      headers: { "content-type": "application/json" },
      payload: { query },
    });
    const body = res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toMatch(/missing bearer token|unauthorized/);
  });
});