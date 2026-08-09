# API Gateway / BFF

![CI](https://github.com/ai-crypto-onramp/gateway-api/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/ai-crypto-onramp/gateway-api/branch/main/graph/badge.svg)](https://codecov.io/gh/ai-crypto-onramp/gateway-api)

Public edge service for the crypto on-ramp — handles AuthN/Z, rate limiting, request shaping, and aggregates backend calls for web, mobile, and partner SDKs.

## Overview / Responsibilities

- Single public ingress for all client SDKs (web, mobile, partner).
- Terminates TLS and validates credentials before forwarding to internal services.
- Aggregates and shapes responses from multiple backend microservices into SDK-friendly payloads (BFF pattern).
- Enforces per-client rate limiting and quota to protect downstream services.
- Translates external REST/GraphQL API contracts into internal gRPC/REST calls.
- Injects request IDs, propagates trace context, and emits edge-level metrics.
- Shields internal service topology from clients; no internal service is directly reachable from the internet.
- Centralizes cross-cutting concerns: auth, logging, tracing, CORS, compression, response caching.

## Language & Tech Stack

- **Language:** TypeScript (Node.js 20 LTS runtime)
- **HTTP framework:** Fastify (preferred for throughput) or Express
- **BFF layer:** REST (primary) + optional GraphQL endpoint (schema stitching / Apollo Server or Mercurius)
- **HTTP client:** `undici` for downstream calls with connection pooling and retries
- **Schema validation:** `zod` or `ajv` (JSON Schema) for request/response validation
- **Auth:** `jose` for JWT verification, `jwks-rsa` for key rotation
- **Observability:** `@opentelemetry/*`, `pino` for structured logging, `prom-client` for Prometheus metrics
- **Testing:** `vitest` + `supertest`
- **Build:** `tsx` for dev, `tsc` + bundler (esbuild) for production

## System Requirements

### Functional Requirements

- **AuthN/Z passthrough:** Validate JWTs (RS256) issued by the Identity & Auth service and enforce RBAC scopes on every route. Partner API keys are verified and forwarded as internal credentials.
- **Rate limiting:** Token-bucket per API key and per source IP, with distinct tiers for end-user SDK vs partner SDK traffic. Return `429` with `Retry-After` on exhaustion.
- **Request shaping / aggregation:** Compose responses from Identity/Auth, KYC, Pricing, and the Transaction Orchestrator into single client-facing calls where appropriate (e.g., a "session bootstrap" endpoint returning user profile + KYC status + recent transactions).
- **SDK support:** Stable, versioned REST API (`/v1`, `/v2`) for web and mobile SDKs; separate partner SDK surface with API-key auth and webhook registration endpoints.
- **Quote and transaction proxying:** Forward quote requests to Pricing and transaction lifecycle calls to the Transaction Orchestrator; translate orchestration saga state into client-facing status enums.
- **Idempotency:** Accept `Idempotency-Key` on mutating endpoints and forward to downstream services.
- **Webhooks:** Register and validate partner webhook URLs; sign outgoing webhook payloads.
- **Versioning & deprecation:** Header-based version negotiation; sunset headers for deprecated routes.
- **CORS & security headers:** Strict CORS allow-lists per SDK origin; HSTS, CSP, and other security headers on edge responses.

## Non-Functional Requirements

- **Latency:** p99 < 50ms added edge overhead (excluding downstream call time); p99.9 < 150ms.
- **Scalability:** Horizontally scalable, stateless behind a load balancer; rate-limit state shared via Redis so any instance can serve any request.
- **Availability:** 99.99% SLO (≤ ~4.5 min downtime/month); graceful degradation returns cached/last-known-good when downstream is unavailable.
- **Security:** TLS 1.2+ termination at the edge; mTLS optional for partner traffic; no sensitive data logged.
- **Throughput:** Sustain ≥ 10,000 RPS per region with sub-linear resource growth.
- **Resilience:** Circuit breakers, bulkheads, and timeouts on every downstream integration; retries with jitter only on idempotent calls.
- **Observability:** 100% of requests carry a propagated trace ID; RED metrics (Rate, Errors, Duration) per route.
- **Deployability:** Zero-downtime rolling deploys; health and readiness probes.

## Technical Specifications

### API Surface

- **REST:** Primary JSON-over-HTTP API under `/v1/*` (and `/v2/*` as needed).
- **GraphQL (optional BFF):** `/v1/graphql` endpoint exposing a stitched schema for SDK clients that benefit from aggregated queries (e.g., dashboard bootstrap). REST remains the source of truth.

### Endpoints (sample)

| Method | Path | Description | Downstream |
|---|---|---|---|
| `POST` | `/v1/auth/session` | Exchange/refresh session token | identity-auth |
| `GET`  | `/v1/me` | Current user profile + KYC status (aggregated) | identity-auth, onboarding-kyc |
| `POST` | `/v1/quotes` | Request a price quote with rate lock | pricing-quote |
| `POST` | `/v1/transactions` | Initiate a buy transaction | transaction-orchestrator |
| `GET`  | `/v1/transactions/:id` | Transaction status (aggregated with ledger state) | transaction-orchestrator |
| `GET`  | `/v1/transactions` | Paginated transaction history | transaction-orchestrator |
| `POST` | `/v1/kyc/start` | Begin KYC flow | onboarding-kyc |
| `GET`  | `/v1/kyc/status` | KYC verification status | onboarding-kyc |
| `POST` | `/v1/partner/webhooks` | Register partner webhook URL | identity-auth (partner registry) |
| `GET`  | `/healthz` / `/readyz` | Liveness / readiness probes | local |

### Integrations (downstream)

| Service | Purpose | Protocol |
|---|---|---|
| `identity-auth` | User/session validation, RBAC, partner API keys | REST/gRPC |
| `onboarding-kyc` | KYC status and flow initiation | REST/gRPC |
| `pricing-quote` | Real-time quotes with rate lock | REST/gRPC |
| `transaction-orchestrator` | Transaction saga lifecycle | REST/gRPC |

All downstream calls go through a shared HTTP client with connection pooling, circuit breakers (e.g., `opossum`), per-service timeouts, and OpenTelemetry tracing spans.

### Auth

- **End-user SDK:** `Authorization: Bearer <JWT>` (RS256). JWKS cached and refreshed on a timer; fallback fetch on unknown `kid`. Scopes validated per route (e.g., `tx:write`, `kyc:read`).
- **Partner SDK:** `X-API-Key: <key>` verified against identity-auth partner registry; mapped to an internal service identity and forwarded as a signed internal token.
- **Internal calls:** The gateway attaches an internal service token (mTLS or signed JWT) when calling downstream services; downstream services reject unauthenticated internal traffic.

### Rate Limiting

- **Algorithm:** Token bucket, shared state in Redis (`@redis/client` or `ioredis`).
- **Dimensions:** Per API key (partner), per user ID (SDK), per source IP (anonymous/auth-failed).
- **Tiers:** Configurable per-key overrides via a limits config service or feature flag.
- **Behavior:** `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers (`Limit`, `Remaining`, `Reset`).
- **Burst:** Bucket size and refill rate tuned per tier (e.g., end-user 10 RPS / burst 20; partner 100 RPS / burst 200).

### Observability

- **Tracing:** OpenTelemetry SDK with auto-instrumentation for Fastify/Express, `undici`, and Redis; traces exported via OTLP to the platform collector. W3C tracecontext propagated to all downstreams.
- **Logging:** Structured JSON logs via `pino` with request ID, user ID (hashed), route, status, latency. No PII or secrets.
- **Metrics:** Prometheus metrics via `prom-client` — RED metrics per route (`http_requests_total`, `http_request_duration_seconds`, `http_requests_errors_total`), plus gateway-specific (`rate_limit_rejections_total`, `downstream_circuit_state`, `jwks_refresh_total`).
- **Health:** `/healthz` (liveness) and `/readyz` (checks downstream reachability + Redis connectivity).

## Dependencies

### Downstream Services

- **identity-auth** (Go) — user accounts, sessions, MFA, partner API keys, RBAC.
- **onboarding-kyc** (Go) — KYC orchestration, document/liveness, sanctions/PEP screening.
- **pricing-quote** (Go) — real-time rate quotes with rate-lock window.
- **transaction-orchestrator** (Go) — saga engine for the end-to-end buy flow.

### Infrastructure

- **Redis** — shared rate-limit state and JWKS cache.
- **OTLP collector** — trace/metric export.
- **Load balancer / ingress** — TLS termination fronting gateway replicas (cloud LB or nginx ingress).
- **Secrets manager** — JWT issuer URLs, partner registry credentials, internal service tokens.

## Configuration

All configuration is via environment variables. Defaults shown where applicable.

| Variable | Description | Example / Default |
|---|---|---|
| `PORT` | HTTP port the gateway listens on | `8080` |
| `LOG_LEVEL` | `pino` log level | `info` |
| `NODE_ENV` | Environment name | `production` |
| `IDENTITY_AUTH_URL` | Base URL for identity-auth service | `http://identity-auth.internal:8080` |
| `KYC_URL` | Base URL for onboarding-kyc service | `http://onboarding-kyc.internal:8080` |
| `PRICING_URL` | Base URL for pricing-quote service | `http://pricing-quote.internal:8080` |
| `ORCHESTRATOR_URL` | Base URL for transaction-orchestrator | `http://transaction-orchestrator.internal:8080` |
| `RATE_LIMIT_RPS` | Default token-bucket refill rate (RPS) | `10` |
| `RATE_LIMIT_BURST` | Default token-bucket burst size | `20` |
| `RATE_LIMIT_REDIS_URL` | Redis connection string for shared limiter | `redis://rate-limit.internal:6379` |
| `JWT_ISSUER` | Expected JWT issuer claim | `https://auth.example.com` |
| `JWKS_URL` | Identity-auth JWKS endpoint | `https://auth.example.com/.well-known/jwks.json` |
| `JWT_AUDIENCE` | Expected JWT audience | `onramp-sdk` |
| `PARTNER_API_KEY_HEADER` | Header name for partner API keys | `X-API-Key` |
| `DOWNSTREAM_TIMEOUT_MS` | Default timeout for downstream calls | `5000` |
| `CIRCUIT_BREAKER_THRESHOLD` | Error % to trip a downstream breaker | `50` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list | `https://app.example.com` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint | `http://otel-collector.internal:4318` |
| `OTEL_SERVICE_NAME` | Service name reported in traces | `api-gateway` |
| `ENABLE_GRAPHQL` | Toggle the `/v1/graphql` BFF endpoint | `false` |
| `WEBHOOK_SIGNING_SECRET` | Secret for signing outbound partner webhooks | (from secrets manager) |

## Local Development

```bash
# Install dependencies
npm install

# Run in dev mode with hot reload
npm run dev

# Build production bundle
npm run build

# Run production server
npm start

# Run tests
npm test

# Run lint
npm run lint

# Run typecheck
npm run typecheck
```

## Deployment

The gateway is packaged as a non-root Docker image built from the
multi-stage `Dockerfile`. It exposes port `8080` with a `HEALTHCHECK`
against `/healthz`. Deploy behind a TLS-terminating load balancer with
rolling updates driven by `/readyz`.

```bash
docker build -t api-gateway .
docker run --rm -p 8080:8080 \
  --env-file .env \
  -e RATE_LIMIT_REDIS_URL=redis://redis:6379 \
  api-gateway
```

`docker compose up` starts the full local stack: the gateway, Redis for
shared rate-limit state, an OTLP collector for traces, and a mock
downstream that emulates `identity-auth`, `onboarding-kyc`,
`pricing-quote`, and `transaction-orchestrator`.

### SLOs

| Metric | Target |
|---|---|
| Availability | 99.99% (≤ ~4.5 min downtime/month) |
| Edge overhead p99 | < 50ms (excluding downstream time) |
| Edge overhead p99.9 | < 150ms |
| Sustained throughput | ≥ 10,000 RPS per region |

### Downstream Dependency Map

| Service | Purpose | Circuit breaker | Cache TTL |
|---|---|---|---|
| `identity-auth` | sessions, profile, partner registry | 30s reset, 50% threshold | 30s (profile) |
| `onboarding-kyc` | KYC status & flow | 30s reset, 50% threshold | 15s (status) |
| `pricing-quote` | quotes with rate lock | 30s reset, 50% threshold | — |
| `transaction-orchestrator` | transaction saga | 30s reset, 50% threshold | 5s (get) |

### Observability Endpoints

- `GET /healthz` — liveness (always returns `{"status":"ok"}`).
- `GET /readyz` — readiness; reports `degraded` when Redis is
  unreachable or any downstream circuit is open.
- `GET /metrics` — Prometheus text exposition of RED metrics
  (`http_requests_total`, `http_request_duration_seconds`,
  `http_requests_errors_total`), `rate_limit_rejections_total`,
  `downstream_circuit_state`, and `jwks_refresh_total`.

## Troubleshooting / On-Call Runbook

### Circuit breaker trips

Symptom: `downstream_circuit_state{service="X"} == 2` (open) and a
rise in `http_requests_errors_total{status="503"}`.

1. Check the downstream service health and its own metrics.
2. The breaker auto-resets after 30s; if it re-opens immediately the
   downstream is still failing.
3. Graceful degradation serves last-known-good cached responses for
   `GET /v1/me` (profile), `GET /v1/kyc/status`, and
   `GET /v1/transactions/:id` while the breaker is open.
4. If the downstream is down for a prolonged period, consider draining
   traffic from affected instances via `/readyz` (returns `degraded`).

### JWKS rotation failure

Symptom: `jwks_refresh_total{result="error"}` increasing and 401s on
authenticated routes.

1. Verify `JWKS_URL` is reachable from the gateway pods.
2. The verifier retries on unknown `kid` with a fallback fetch; if the
   JWKS endpoint itself is down, all new tokens will be rejected.
3. Rotate the `JWT_ISSUER`/`JWKS_URL` secrets and restart the pods if
   the issuer changed its JWKS endpoint.

### Redis limiter outage

Symptom: `rate_limit_rejections_total` drops to zero and 429s stop, or
`/readyz` reports `redis: false`.

1. Confirm `RATE_LIMIT_REDIS_URL` points to a healthy Redis.
2. If Redis is unavailable, the limiter will fail open or closed
   depending on configuration; document the expected behavior for your
   deployment.
3. Restore Redis; the token-bucket state is shared and recovers
   automatically once connectivity returns. No gateway restart is
   required.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branching, commit
conventions, and review.