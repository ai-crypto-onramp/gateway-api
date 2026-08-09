import type { FastifyInstance, FastifyRequest } from "fastify";
import mercurius from "mercurius";
import { typeDefs } from "./schema.js";
import type { DownstreamClients } from "../clients/types.js";
import type { AuthPrincipal } from "../auth/index.js";

export function registerGraphQL(
  app: FastifyInstance,
  clients: DownstreamClients,
  jwtAuth?: (req: FastifyRequest, reply: never) => Promise<void>,
) {
  if (jwtAuth) {
    app.addHook("preHandler", async (req: FastifyRequest) => {
      if (req.routerPath === "/graphql" || req.url.startsWith("/graphql")) {
        await jwtAuth(req, undefined as never);
      }
    });
  }
  (app.register as unknown as (plugin: unknown, opts: unknown) => void)(mercurius, {
    schema: typeDefs,
    graphiql: false,
    context: (req: FastifyRequest) => ({ req }),
    resolvers: {
      Query: {
        async me(_root: unknown, _args: unknown, ctx: { req: FastifyRequest }) {
          const p = ctx.req.principal as AuthPrincipal | undefined;
          const userId = p?.userId ?? "anonymous";
          const [user, kyc] = await Promise.all([
            clients.identityAuth.getProfile(userId),
            clients.kyc.getStatus(userId),
          ]);
          return { user, kyc };
        },
        async kycStatus(_root: unknown, _args: unknown, ctx: { req: FastifyRequest }) {
          const p = ctx.req.principal as AuthPrincipal | undefined;
          const userId = p?.userId ?? "anonymous";
          return clients.kyc.getStatus(userId);
        },
        async transaction(_root: unknown, args: { id: string }) {
          const r = await clients.orchestrator.getTransaction(args.id);
          const rest = r as Omit<typeof r, "sagaState">;
          return rest;
        },
        async transactions(_root: unknown, args: { limit: number; cursor?: string }, ctx: { req: FastifyRequest }) {
          const p = ctx.req.principal as AuthPrincipal | undefined;
          const userId = p?.userId ?? "anonymous";
          return clients.orchestrator.listTransactions(userId, {
            limit: args.limit ?? 20,
            cursor: args.cursor ?? null,
          });
        },
      },
      Mutation: {
        async createQuote(_root: unknown, args: { input: Parameters<DownstreamClients["pricing"]["createQuote"]>[0] }) {
          return clients.pricing.createQuote(args.input);
        },
        async initiateTransaction(
          _root: unknown,
          args: { input: Parameters<DownstreamClients["orchestrator"]["initiate"]>[0]; idempotencyKey: string },
          ctx: { req: FastifyRequest },
        ) {
          const p = ctx.req.principal as AuthPrincipal | undefined;
          return clients.orchestrator.initiate({
            ...args.input,
            idempotencyKey: args.idempotencyKey,
            userId: p?.userId ?? "anonymous",
          });
        },
        async startKyc(_root: unknown, args: { flow?: string; redirectUrl?: string }, ctx: { req: FastifyRequest }) {
          const p = ctx.req.principal as AuthPrincipal | undefined;
          const userId = p?.userId ?? "anonymous";
          return clients.kyc.start(userId, {
            flow: (args.flow as "standard" | "document" | "liveness") ?? "standard",
            redirectUrl: args.redirectUrl,
          });
        },
      },
    },
  });
}