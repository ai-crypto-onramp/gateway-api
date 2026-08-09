import { describe, it, expect } from "vitest";
import { loadConfig, ConfigSchema, DEFAULT_TEST_ENV } from "./config.js";

describe("config", () => {
  it("parses the README defaults", () => {
    const cfg = loadConfig(DEFAULT_TEST_ENV);
    expect(cfg.PORT).toBe(8080);
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.NODE_ENV).toBe("test");
    expect(cfg.RATE_LIMIT_RPS).toBe(10);
    expect(cfg.RATE_LIMIT_BURST).toBe(20);
    expect(cfg.JWT_AUDIENCE).toBe("onramp-sdk");
    expect(cfg.PARTNER_API_KEY_HEADER).toBe("X-API-Key");
    expect(cfg.DOWNSTREAM_TIMEOUT_MS).toBe(5000);
    expect(cfg.CIRCUIT_BREAKER_THRESHOLD).toBe(50);
    expect(cfg.OTEL_SERVICE_NAME).toBe("api-gateway");
    expect(cfg.ENABLE_GRAPHQL).toBe(false);
  });

  it("applies defaults when required URLs are unset", () => {
    const cfg = loadConfig({});
    expect(cfg.IDENTITY_AUTH_URL).toBe("http://identity-auth.internal:8080");
    expect(cfg.JWKS_URL).toBe("https://auth.example.com/.well-known/jwks.json");
    expect(cfg.JWT_ISSUER).toBe("https://auth.example.com");
  });

  it("fails fast on invalid URL", () => {
    expect(() =>
      loadConfig({ ...DEFAULT_TEST_ENV, IDENTITY_AUTH_URL: "not-a-url" }),
    ).toThrow(/Invalid configuration/);
  });

  it("coerces numeric env vars", () => {
    const cfg = loadConfig({ ...DEFAULT_TEST_ENV, PORT: "9090", RATE_LIMIT_RPS: "42" });
    expect(cfg.PORT).toBe(9090);
    expect(cfg.RATE_LIMIT_RPS).toBe(42);
  });

  it("parses ENABLE_GRAPHQL truthy values", () => {
    expect(loadConfig({ ...DEFAULT_TEST_ENV, ENABLE_GRAPHQL: "true" }).ENABLE_GRAPHQL).toBe(true);
    expect(loadConfig({ ...DEFAULT_TEST_ENV, ENABLE_GRAPHQL: "1" }).ENABLE_GRAPHQL).toBe(true);
    expect(loadConfig({ ...DEFAULT_TEST_ENV, ENABLE_GRAPHQL: "false" }).ENABLE_GRAPHQL).toBe(false);
  });

  it("schema shape matches README config table keys", () => {
    const keys = Object.keys(ConfigSchema.shape);
    for (const expected of [
      "PORT",
      "LOG_LEVEL",
      "NODE_ENV",
      "IDENTITY_AUTH_URL",
      "KYC_URL",
      "PRICING_URL",
      "ORCHESTRATOR_URL",
      "RATE_LIMIT_RPS",
      "RATE_LIMIT_BURST",
      "RATE_LIMIT_REDIS_URL",
      "JWT_ISSUER",
      "JWKS_URL",
      "JWT_AUDIENCE",
      "PARTNER_API_KEY_HEADER",
      "DOWNSTREAM_TIMEOUT_MS",
      "CIRCUIT_BREAKER_THRESHOLD",
      "CORS_ALLOWED_ORIGINS",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_SERVICE_NAME",
      "ENABLE_GRAPHQL",
      "WEBHOOK_SIGNING_SECRET",
    ]) {
      expect(keys).toContain(expected);
    }
  });
});