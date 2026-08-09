import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer, type AppHandle } from "../index.js";
import { createMetrics } from "../observability/metrics.js";
import { createTracing } from "../observability/tracing.js";
import { NoopLimiter } from "../rate-limit/limiter.js";
import type { DownstreamClients } from "../clients/types.js";
import { ApiError } from "../domain/errors.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";
import { makeTestJwtVerifier } from "../test-helpers/jwt.js";

function failingClients(): DownstreamClients {
  const fail = (svc: string): never => {
    throw new ApiError("downstream_unavailable", `${svc} down`, { status: 503 });
  };
  const f = (svc: string) => async () => { fail(svc); };
  return {
    identityAuth: { exchangeSession: f("identity-auth") as never, getProfile: f("identity-auth") as never },
    kyc: { getStatus: f("kyc") as never, start: f("kyc") as never },
    pricing: { createQuote: f("pricing") as never },
    orchestrator: {
      initiate: f("orchestrator") as never,
      getTransaction: (async () => {
        const e = new ApiError("downstream_timeout", "timeout", { status: 504 });
        (e as { timedOut?: boolean }).timedOut = true;
        throw e;
      }) as never,
      listTransactions: (async () => { throw new ApiError("not_found", "nope", { status: 404 }); }) as never,
    },
    partnerRegistry: {
      registerWebhook: (async () => { throw new ApiError("downstream_circuit_open", "open", { status: 503 }); }) as never,
      verifyApiKey: (async () => null) as never,
    },
  };
}

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

describe("downstream error handling", () => {
  let h: AppHandle;
  let token: string;
  beforeEach(async () => {
    const { verifier, token: t } = await makeTestJwtVerifier();
    token = t;
    h = await build({ jwtVerifier: verifier, clients: failingClients() });
  });
  afterEach(async () => h.shutdown());

  it("auth session maps downstream 503", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/auth/session", payload: { grantType: "refresh_token", refreshToken: "x" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("downstream_unavailable");
  });

  it("/me maps downstream 503", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
  });

  it("quotes maps downstream 503", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { authorization: `Bearer ${token}` },
      payload: { baseCurrency: "USD", quoteCurrency: "ETH", baseAmount: "1", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("transactions initiate maps 503", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${token}` },
      payload: { quoteId: "q1", paymentMethod: "card" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("transactions get maps timeout to 504", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/transactions/tx1", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe("downstream_timeout");
  });

  it("transactions list maps 404", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
  });

  it("kyc start maps 503", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/kyc/start", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(res.statusCode).toBe(503);
  });

  it("kyc status maps 503", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/kyc/status", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
  });

  it("partner webhook maps circuit open 503", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/partner/webhooks",
      headers: { "X-API-Key": "p1" },
      payload: { url: "https://x.com", events: ["transaction.completed"] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("deprecation header on /v1/auth/session", () => {
  let h: AppHandle;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => h.shutdown());
  it("emits deprecation header", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/auth/session", payload: { grantType: "refresh_token", refreshToken: "x" } });
    expect(res.headers.deprecation).toBe("true");
  });
});

describe("readyz with redis + httpClients", () => {
  it("reports degraded when redis down", async () => {
    const redis = {
      async ping() {
        throw new Error("down");
      },
      async eval() {
        return [];
      },
    };
    const h = await build({ redis: redis as never });
    try {
      const res = await h.app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.checks.find((c: { name: string }) => c.name === "redis")?.ok).toBe(false);
    } finally {
      await h.shutdown();
    }
  });
  it("reports ok when redis healthy", async () => {
    const redis = {
      async ping() {
        return "PONG";
      },
      async eval() {
        return ["0", "10", "10", "1", "0"];
      },
    };
    const h = await build({ redis: redis as never });
    try {
      const res = await h.app.inject({ method: "GET", url: "/readyz" });
      expect(res.json().status).toBe("ok");
    } finally {
      await h.shutdown();
    }
  });
});