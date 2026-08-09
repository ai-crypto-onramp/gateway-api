import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export interface Metrics {
  registry: Registry;
  httpRequestsTotal: Counter<string>;
  httpRequestDurationSeconds: Histogram<string>;
  httpRequestsErrorsTotal: Counter<string>;
  rateLimitRejectionsTotal: Counter<string>;
  downstreamCircuitState: Gauge<string>;
  jwksRefreshTotal: Counter<string>;
  shutdown(): void;
}

export function createMetrics(_serviceName = "api-gateway"): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "" });

  const httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const httpRequestDurationSeconds = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const httpRequestsErrorsTotal = new Counter({
    name: "http_requests_errors_total",
    help: "Total HTTP errors",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const rateLimitRejectionsTotal = new Counter({
    name: "rate_limit_rejections_total",
    help: "Rate-limited rejections",
    labelNames: ["tier"],
    registers: [registry],
  });
  const downstreamCircuitState = new Gauge({
    name: "downstream_circuit_state",
    help: "Downstream circuit breaker state (0=closed,1=half-open,2=open)",
    labelNames: ["service"],
    registers: [registry],
  });
  const jwksRefreshTotal = new Counter({
    name: "jwks_refresh_total",
    help: "JWKS refresh attempts",
    labelNames: ["result"],
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    httpRequestsErrorsTotal,
    rateLimitRejectionsTotal,
    downstreamCircuitState,
    jwksRefreshTotal,
    shutdown() {
      registry.clear();
    },
  };
}

export const SERVICE_NAME = "api-gateway";