import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import {
  AuthSessionRequestSchema,
  QuoteRequestSchema,
  InitiateTransactionRequestSchema,
  KycStartRequestSchema,
  PartnerWebhookRegistrationSchema,
  KycStartResponseSchema,
  PartnerWebhookRegistrationResponseSchema,
} from "../domain/schemas.js";
import { ApiError } from "../domain/errors.js";
import { parseIdempotencyKey, newIdempotencyKey } from "../domain/idempotency.js";
import { requireScopes, type AuthPrincipal } from "../auth/index.js";
import type { DownstreamClients } from "../clients/types.js";
import type { AppConfig } from "../config.js";
import type { DownstreamError } from "../clients/downstream.js";

export interface RouteDeps {
  app: FastifyInstance;
  clients: DownstreamClients;
  config: AppConfig;
  jwtAuth: preHandlerHookHandler;
  partnerAuth: preHandlerHookHandler;
  readyz: () => Promise<{ status: string }>;
}

function handleDownstream(err: unknown): never {
  const e = err as DownstreamError;
  const isApi = err instanceof ApiError;
  if (isApi) throw err;
  if (e?.timedOut) throw new ApiError("downstream_timeout", e.message, { status: 504, cause: err });
  if (/circuit open/.test(e?.message ?? "")) {
    throw new ApiError("downstream_circuit_open", e.message, { status: 503, cause: err });
  }
  if (e?.status === 503) throw new ApiError("downstream_unavailable", e.message, { status: 503, cause: err });
  if (e?.status && e.status >= 500) throw new ApiError("downstream_unavailable", e.message, { status: 503, cause: err });
  if (e?.status === 404) throw new ApiError("not_found", e.message, { status: 404 });
  throw new ApiError("internal_error", (err as Error)?.message ?? "downstream error", { cause: err });
}

function details(err: unknown) {
  const z = err as { issues?: { path: (string | number)[]; message: string }[] };
  return z.issues?.map((i) => ({ field: i.path.join("."), message: i.message }));
}

export function registerRoutes(deps: RouteDeps) {
  const { app, clients, jwtAuth, partnerAuth, readyz } = deps;

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async () => readyz());

  app.post("/v1/auth/session", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = AuthSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError("invalid_request", "validation failed", { details: details(parsed.error) });
    try {
      const res = await clients.identityAuth.exchangeSession(parsed.data);
      reply.code(200).send(res);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.get("/v1/me", { preHandler: [jwtAuth, requireScopes("me:read")] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.principal as AuthPrincipal;
    try {
      const [user, kyc] = await Promise.all([
        clients.identityAuth.getProfile(p.userId ?? "anonymous"),
        clients.kyc.getStatus(p.userId ?? "anonymous"),
      ]);
      reply.send({ user, kyc });
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.post("/v1/quotes", { preHandler: [jwtAuth, requireScopes("quotes:write")] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = QuoteRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError("invalid_request", "validation failed", { details: details(parsed.error) });
    try {
      const res = await clients.pricing.createQuote(parsed.data);
      reply.code(201).send(res);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.post("/v1/transactions", { preHandler: [jwtAuth, requireScopes("tx:write")] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = InitiateTransactionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError("invalid_request", "validation failed", { details: details(parsed.error) });
    const p = req.principal as AuthPrincipal;
    const idempotencyKey = parseIdempotencyKey(req.headers as Record<string, string | string[] | undefined>) ?? newIdempotencyKey();
    try {
      const res = await clients.orchestrator.initiate({
        ...parsed.data,
        idempotencyKey,
        userId: p.userId ?? "anonymous",
      });
      reply.code(201)
        .header("idempotency-key", idempotencyKey)
        .send(res);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/transactions/:id", { preHandler: [jwtAuth, requireScopes("tx:read")] }, async (req, reply) => {
    try {
      const r = await clients.orchestrator.getTransaction(req.params.id);
      const { sagaState: _s, ...rest } = r;
      void _s;
      reply.send(rest);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.get("/v1/transactions", { preHandler: [jwtAuth, requireScopes("tx:read")] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.principal as AuthPrincipal;
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? "20"), 100);
    const cursor = (req.query as { cursor?: string }).cursor ?? null;
    try {
      const res = await clients.orchestrator.listTransactions(p.userId ?? "anonymous", { limit, cursor });
      reply.send(res);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.post("/v1/kyc/start", { preHandler: [jwtAuth, requireScopes("kyc:write")] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = KycStartRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError("invalid_request", "validation failed", { details: details(parsed.error) });
    const p = req.principal as AuthPrincipal;
    try {
      const res = await clients.kyc.start(p.userId ?? "anonymous", parsed.data);
      const validated = KycStartResponseSchema.parse(res);
      reply.code(201).send(validated);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.get("/v1/kyc/status", { preHandler: [jwtAuth, requireScopes("kyc:read")] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.principal as AuthPrincipal;
    try {
      const res = await clients.kyc.getStatus(p.userId ?? "anonymous");
      reply.send(res);
    } catch (err) {
      handleDownstream(err);
    }
  });

  app.post("/v1/partner/webhooks", { preHandler: [partnerAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = PartnerWebhookRegistrationSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError("invalid_request", "validation failed", { details: details(parsed.error) });
    const p = req.principal as AuthPrincipal;
    if (!p.partnerId) throw new ApiError("forbidden", "partner identity required");
    try {
      const res = await clients.partnerRegistry.registerWebhook(p.partnerId, parsed.data);
      const validated = PartnerWebhookRegistrationResponseSchema.parse(res);
      reply.code(201).send(validated);
    } catch (err) {
      handleDownstream(err);
    }
  });
}