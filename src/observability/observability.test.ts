import { describe, it, expect } from "vitest";
import { createMetrics } from "./metrics.js";
import { createTracing } from "./tracing.js";
import { createLogger } from "./logger.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";

describe("metrics", () => {
  it("creates all metrics and registers defaults", async () => {
    const m = createMetrics("api-gateway-test");
    m.httpRequestsTotal.inc({ method: "GET", route: "/x", status: "200" });
    m.httpRequestDurationSeconds.observe({ method: "GET", route: "/x" }, 0.01);
    m.httpRequestsErrorsTotal.inc({ method: "GET", route: "/x", status: "500" });
    m.rateLimitRejectionsTotal.inc({ tier: "ip" });
    m.downstreamCircuitState.set({ service: "identity-auth" }, 0);
    m.jwksRefreshTotal.inc({ result: "success" });
    const out = await m.registry.metrics();
    expect(out).toContain("http_requests_total");
    expect(out).toContain("rate_limit_rejections_total");
    expect(out).toContain("downstream_circuit_state");
    m.shutdown();
  });
});

describe("tracing", () => {
  it("returns noop tracing when no OTLP endpoint", () => {
    const cfg = loadConfig({ ...DEFAULT_TEST_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: "" });
    const t = createTracing(cfg);
    expect(t.started).toBe(false);
    expect(t.inject()).toEqual({});
    return t.shutdown();
  });
});

describe("logger", () => {
  it("creates pino logger with redaction", () => {
    const cfg = loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "test", LOG_LEVEL: "info" });
    const log = createLogger(cfg);
    expect(typeof log.info).toBe("function");
  });
});