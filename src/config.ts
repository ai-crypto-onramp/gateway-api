import { z } from "zod";

const TierRateLimitSchema = z.object({
  rps: z.number().int().positive(),
  burst: z.number().int().positive(),
});

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.string().default("production"),

  IDENTITY_AUTH_URL: z.string().url().default("http://identity-auth.internal:8080"),
  KYC_URL: z.string().url().default("http://onboarding-kyc.internal:8080"),
  PRICING_URL: z.string().url().default("http://pricing-quote.internal:8080"),
  ORCHESTRATOR_URL: z.string().url().default("http://transaction-orchestrator.internal:8080"),

  RATE_LIMIT_RPS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_BURST: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_REDIS_URL: z.string().default(""),

  JWT_ISSUER: z.string().default("https://auth.example.com"),
  JWKS_URL: z.string().url().default("https://auth.example.com/.well-known/jwks.json"),
  JWT_AUDIENCE: z.string().default("onramp-sdk"),

  PARTNER_API_KEY_HEADER: z.string().default("X-API-Key"),

  DOWNSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(0).max(100).default(50),

  CORS_ALLOWED_ORIGINS: z.string().default(""),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().default("api-gateway"),

  ENABLE_GRAPHQL: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .pipe(z.coerce.boolean())
    .default(false),

  WEBHOOK_SIGNING_SECRET: z.string().default(""),

  RATE_LIMIT_TIER_END_USER: TierRateLimitSchema.optional(),
  RATE_LIMIT_TIER_PARTNER: TierRateLimitSchema.optional(),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export type EnvSource = Record<string, string | undefined>;

function toEnvRecord(input: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(ConfigSchema.shape)) {
    const v = input[key];
    if (v !== undefined && v !== "") out[key] = String(v);
  }
  return out;
}

export function loadConfig(env: EnvSource = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(toEnvRecord(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

export const DEFAULT_TEST_ENV: Required<EnvSource> = {
  PORT: "8080",
  LOG_LEVEL: "info",
  NODE_ENV: "test",
  IDENTITY_AUTH_URL: "http://identity-auth.internal:8080",
  KYC_URL: "http://onboarding-kyc.internal:8080",
  PRICING_URL: "http://pricing-quote.internal:8080",
  ORCHESTRATOR_URL: "http://transaction-orchestrator.internal:8080",
  RATE_LIMIT_RPS: "10",
  RATE_LIMIT_BURST: "20",
  RATE_LIMIT_REDIS_URL: "",
  JWT_ISSUER: "https://auth.example.com",
  JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
  JWT_AUDIENCE: "onramp-sdk",
  PARTNER_API_KEY_HEADER: "X-API-Key",
  DOWNSTREAM_TIMEOUT_MS: "5000",
  CIRCUIT_BREAKER_THRESHOLD: "50",
  CORS_ALLOWED_ORIGINS: "https://app.example.com",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_SERVICE_NAME: "api-gateway",
  ENABLE_GRAPHQL: "false",
  WEBHOOK_SIGNING_SECRET: "test-secret",
  RATE_LIMIT_TIER_END_USER: "",
  RATE_LIMIT_TIER_PARTNER: "",
  SHUTDOWN_TIMEOUT_MS: "10000",
};