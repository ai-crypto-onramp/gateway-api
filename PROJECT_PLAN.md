# Project Plan — API Gateway / BFF

This plan breaks the API Gateway / BFF build into ordered implementation stages derived from the
spec in `README.md` (system requirements, technical specs, endpoints, downstream integrations,
auth, rate limiting, observability, and configuration). Stages progress from project scaffolding
through core domain logic, endpoint handlers, downstream integrations, auth/security, rate
limiting, observability, tests/coverage, Docker/CI hardening, and docs.

## Stage 1: Project Scaffolding & Configuration

Goal: Stand up the Node.js 20 / TypeScript service skeleton with Fastify, config loading, and
baseline dev/build/test/lint/typecheck scripts matching the README stack.

Tasks:
- [x] Initialize `package.json` with Node 20 engine, ESM, and scripts (`dev`, `build`, `start`, `test`, `lint`, `typecheck`).
- [x] Set up TypeScript config (`tsconfig.json`) targeting Node 20 with strict mode.
- [x] Install and wire Fastify as the HTTP framework with a root plugin registry.
- [x] Add `tsx` for dev, `tsc` + `esbuild` bundler config for production build.
- [x] Implement typed config loader reading all env vars from the README config table with defaults and validation (zod).
- [x] Add `vitest` + `supertest` test harness and a sample smoke test.
- [x] Add ESLint + Prettier config consistent with the repo conventions.
- [x] Add `.env.example` mirroring the README config table.

Acceptance criteria:
- `npm run dev`, `npm run build`, `npm start`, `npm test`, `npm run lint`, `npm run typecheck` all succeed on an empty app.
- Missing/invalid required env vars fail fast with a clear error at boot.
- Config object is fully typed and unit-tested against the README defaults.

## Stage 2: Core Domain Models & Schema Validation

Goal: Define the typed domain models, request/response schemas, and shared error/HTTP utilities
that endpoint handlers and integrations will build on.

Tasks:
- [x] Define zod schemas for all client-facing request/response bodies (auth session, `/me`, quotes, transactions, KYC, partner webhooks).
- [x] Define enums for client-facing transaction status (translated from orchestrator saga state) and KYC status.
- [x] Implement a centralized error model (`ApiError`) mapping domain errors to fastify error replies with stable error codes.
- [x] Implement idempotency-key header parsing/validation utility.
- [x] Implement request-ID generation and propagation utility.
- [x] Define paginated response envelope shape.
- [x] Add unit tests for schemas and error mapping.

Acceptance criteria:
- Every endpoint in the README table has request and response zod schemas with tests.
- Invalid request bodies are rejected with a 400 and structured error payload.
- Transaction status mapping from orchestrator saga state → client enum is documented and tested.

## Stage 3: Endpoint Handlers & Request Shaping

Goal: Implement the REST `/v1/*` endpoint surface from the README as handlers that validate input,
call downstream clients (mocked at this stage), and shape aggregated BFF responses.

Tasks:
- [x] Register `/healthz` and `/readyz` routes (readyz stubbed to healthy).
- [x] Implement `POST /v1/auth/session` (exchange/refresh).
- [x] Implement `GET /v1/me` (aggregated profile + KYC status).
- [x] Implement `POST /v1/quotes` (forward to pricing, rate lock).
- [x] Implement `POST /v1/transactions` (initiate; forward `Idempotency-Key`).
- [x] Implement `GET /v1/transactions/:id` (status aggregated with ledger state).
- [x] Implement `GET /v1/transactions` (paginated history).
- [x] Implement `POST /v1/kyc/start` and `GET /v1/kyc/status`.
- [x] Implement `POST /v1/partner/webhooks` (register webhook URL).
- [x] Add version negotiation (`/v1`, `/v2`) and sunset/deprecation header support.
- [x] Add CORS plugin with allow-list from `CORS_ALLOWED_ORIGINS` and security headers (HSTS, CSP).

Acceptance criteria:
- All routes return shaped, schema-validated responses using mocked downstream clients.
- Aggregation endpoints (`/me`, `/transactions/:id`) merge multiple downstream payloads into one SDK-friendly payload.
- Deprecation headers are emitted for flagged routes.
- Integration tests via `supertest` cover happy path + validation errors per route.

## Stage 4: Downstream Integrations & Resilience

Goal: Build the shared HTTP client layer (`undici` + circuit breakers + timeouts + tracing spans)
and wire real calls to `identity-auth`, `onboarding-kyc`, `pricing-quote`, and
`transaction-orchestrator`.

Tasks:
- [x] Implement a shared downstream client factory using `undici` with per-service connection pools.
- [x] Integrate `opossum` circuit breakers per downstream service using `CIRCUIT_BREAKER_THRESHOLD`.
- [x] Apply per-service timeouts from `DOWNSTREAM_TIMEOUT_MS` and bulkhead concurrency limits.
- [x] Implement retries-with-jitter only on idempotent downstream calls.
- [x] Inject W3C tracecontext headers on every downstream call and record OTel spans.
- [x] Attach an internal service token (mTLS or signed JWT) to downstream calls.
- [x] Implement graceful degradation: return cached/last-known-good where applicable when a downstream is unavailable.
- [x] Wire each handler from Stage 3 to its real downstream client(s).
- [x] Add contract tests against downstream mocks simulating timeouts, 5xx, and circuit-open states.

Acceptance criteria:
- Every downstream call goes through the shared client with pooling, timeout, breaker, and tracing.
- Circuit open → requests fail fast with a structured error and `downstream_circuit_state` reflects the change.
- Retries are only attempted on idempotent calls and never on non-idempotent mutations.
- Graceful degradation returns last-known-good for designated endpoints when downstream is unreachable.

## Stage 5: Authentication & Authorization

Goal: Implement AuthN/Z for end-user SDK (JWT/JWKS), partner SDK (API key), and internal service
token issuance for downstream calls, plus RBAC scope enforcement per route.

Tasks:
- [x] Implement JWT (RS256) verification with `jose` and JWKS via `jwks-rsa` (cached + refreshed on timer; fallback fetch on unknown `kid`).
- [x] Validate `iss`, `aud` (`JWT_AUDIENCE`), and exp; reject invalid tokens with 401.
- [x] Implement per-route RBAC scope checks (e.g., `tx:write`, `kyc:read`).
- [x] Implement partner API key auth via `X-API-Key` verified against identity-auth partner registry; map to internal identity.
- [x] Implement issuance/signing of internal service token for downstream calls (mTLS or signed JWT).
- [x] Forward partner/user identity to downstreams as internal credentials.
- [x] Add optional mTLS support for partner traffic.
- [x] Add tests for valid/invalid/expired tokens, unknown `kid`, missing scopes, and invalid API keys.

Acceptance criteria:
- End-user routes reject unauthenticated or insufficient-scope requests with 401/403.
- Partner routes reject invalid API keys and forward mapped internal identity to downstreams.
- JWKS rotation is handled without downtime; unknown `kid` triggers fallback fetch.
- No PII or raw tokens are logged.

## Stage 6: Rate Limiting & Quota

Goal: Implement Redis-backed token-bucket rate limiting across per-API-key, per-user, and per-IP
dimensions with tiered burst/refill, `429` responses, and rate-limit headers.

Tasks:
- [x] Integrate Redis client (`@redis/client` or `ioredis`) using `RATE_LIMIT_REDIS_URL`.
- [x] Implement token-bucket limiter with shared state in Redis (atomic Lua/script).
- [x] Apply dimensions: per API key (partner), per user ID (SDK), per source IP (anonymous/auth-failed).
- [x] Implement configurable tiers and per-key overrides (end-user 10 RPS / burst 20; partner 100 RPS / burst 200).
- [x] Return `429` with `Retry-After` and `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.
- [x] Wire limiter as a Fastify preHandler keyed by auth dimension.
- [x] Add `rate_limit_rejections_total` metric.
- [x] Add tests covering tier enforcement, header correctness, and Redis-down behavior.

Acceptance criteria:
- Limit is enforced consistently across instances via shared Redis state.
- `429` responses include correct `Retry-After` and `X-RateLimit-*` headers.
- Per-tier overrides take effect without redeploy.
- `rate_limit_rejections_total` increments on every rejection.

## Stage 7: Observability (Tracing, Logging, Metrics)

Goal: Implement full observability — OpenTelemetry tracing, structured `pino` logging, Prometheus
RED metrics, and readiness checks reflecting downstream/Redis health.

Tasks:
- [x] Initialize OpenTelemetry SDK with auto-instrumentation for Fastify, `undici`, and Redis; export via OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`.
- [x] Propagate W3C tracecontext both inbound (extract) and outbound (inject to downstreams).
- [x] Configure `pino` structured JSON logs with request ID, hashed user ID, route, status, latency; no PII/secrets.
- [x] Implement `prom-client` RED metrics per route (`http_requests_total`, `http_request_duration_seconds`, `http_requests_errors_total`).
- [x] Add gateway-specific metrics (`rate_limit_rejections_total`, `downstream_circuit_state`, `jwks_refresh_total`).
- [x] Expose `/metrics` (or a configured endpoint) for Prometheus scrape.
- [x] Implement `/readyz` checking downstream reachability + Redis connectivity; `/healthz` remains liveness-only.
- [x] Add tests asserting trace/header propagation and metric label cardinality.

Acceptance criteria:
- 100% of requests carry a propagated trace ID end-to-end.
- Logs are structured JSON with no PII/secrets and include required fields.
- RED metrics are emitted per route with bounded label cardinality.
- `/readyz` reports unhealthy when any critical dependency is unreachable.

## Stage 8: Optional GraphQL BFF & Webhooks

Goal: Add the optional `/v1/graphql` stitched-schema BFF endpoint and the partner webhook
registration/signing flow.

Tasks:
- [x] Gate GraphQL behind `ENABLE_GRAPHQL`; add Apollo Server or Mercurius integration with Fastify.
- [x] Stitch schemas from downstream services for dashboard/bootstrap-style aggregated queries (REST remains source of truth).
- [x] Reuse AuthN/Z, rate limiting, tracing, and metrics on the GraphQL endpoint.
- [x] Implement partner webhook registration validation (URL reachability/ownership check).
- [x] Implement outbound webhook payload signing using `WEBHOOK_SIGNING_SECRET` (HMAC) with replay protection.
- [x] Add tests for GraphQL auth/scope enforcement and webhook signing/verification.

Acceptance criteria:
- GraphQL disabled by default; enabling it does not affect REST surface.
- Aggregated GraphQL queries return the same data as the equivalent REST composition.
- Outgoing webhooks are signed and verifiable; recipients can detect tampering/replay.
- Webhook registration rejects invalid/unreachable URLs.

## Stage 9: Test Coverage & Performance Hardening

Goal: Add unit/integration tests and verify NFRs (p99 edge overhead, throughput,
resilience) with targeted performance tests.

Tasks:
- [x] Raise line coverage across handlers, client, auth, and limiter modules.
- [x] Add end-to-end integration suite with all downstreams mocked + Redis in testcontainer.
- [x] Add fault-injection tests: downstream timeout, 5xx storm, breaker open, Redis unavailability.
- [x] Add a load test script (k6 or autocannon) validating p99 < 50ms edge overhead and ≥ 10k RPS sustainability.
- [x] Verify zero-downtime readiness during rolling deploy (health probes + graceful shutdown).
- [x] Add memory/CPU regression guard under sustained load.

Acceptance criteria:
- Coverage reported in CI; uploaded to Codecov.
- p99 edge overhead < 50ms (excluding downstream time) under load test.
- Fault-injection tests pass for all documented resilience scenarios.
- Graceful shutdown drains in-flight requests within shutdown timeout.

## Stage 10: Docker, CI & Docs Hardening

Goal: Productionize packaging, CI pipeline, and developer documentation.

Tasks:
- [x] Add multi-stage `Dockerfile` (build with esbuild, slim runtime image, non-root user).
- [x] Add `docker-compose.yml` for local dev with Redis + OTLP collector + downstream mocks.
- [x] Add GitHub Actions CI workflow: lint, typecheck, test, coverage upload to Codecov, build.
- [x] Add release/semantic-version workflow and container image publish.
- [x] Write `CONTRIBUTING.md` (branching, commit conventions, review).
- [x] Expand README with runbook sections: config matrix, deployment, SLOs, troubleshooting, downstream dependency map.
- [x] Document on-call runbook for breaker trips, JWKS rotation failures, and Redis limiter outages.

Acceptance criteria:
- `docker build` produces a working image that passes `/healthz` and `/readyz`.
- CI runs on every PR and enforces lint/typecheck/test.
- README + CONTRIBUTING fully describe setup, deployment, and operational procedures.
- Container image is published with a semantic version tag from CI.