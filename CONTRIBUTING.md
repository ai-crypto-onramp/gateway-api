# Contributing

## Branching

- All changes are pushed directly to `main` (trunk-based development).
- Keep commits small and focused. Each commit must leave the build green
  (`npm run lint && npm run typecheck && npm test`).
- Long-lived feature branches are discouraged. If you need one, rebase
  frequently and delete it once merged.

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add /v1/graphql endpoint`
- `fix: correct X-RateLimit-Reset header`
- `chore: bump fastify to 4.29`
- `docs: add runbook for JWKS rotation`
- `refactor: extract downstream client factory`
- `test: add fault-injection suite`
- `ci: add docker smoke step`

## Review

- At least one approval is required for non-trivial changes.
- Reviewers should check: schema validation coverage, error mapping,
  PII redaction in logs, metric label cardinality, and downstream
  circuit breaker configuration.
- No secrets or PII may be committed.

## Coverage

- Coverage is reported in CI via `vitest --coverage` and uploaded to Codecov.
- Fault-injection tests (timeouts, 5xx storms, circuit-open, Redis-down)
  must be kept up to date when resilience behavior changes.

## Local Development

```bash
npm install
npm run dev          # tsx watch
npm test             # vitest with coverage
npm run lint
npm run typecheck
docker compose up    # full local stack with Redis + OTLP + mocks
```

## Releasing

- Tags of the form `vX.Y.Z` trigger the `release.yml` workflow, which
  publishes a container image to `ghcr.io/ai-crypto-onramp/api-gateway`
  and creates a GitHub Release with auto-generated notes.
- Follow [Semantic Versioning](https://semver.org/).