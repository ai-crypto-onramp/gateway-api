import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics, type Metrics } from "./observability/metrics.js";
import { createTracing, type Tracing } from "./observability/tracing.js";
import {
  createJwtVerifier,
  createInternalTokenIssuer,
  jwtAuth,
  partnerApiKeyAuth,
  type JwtVerifier,
  type InternalTokenIssuer,
} from "./auth/index.js";
import { createHttpClients, type HttpClientFactory } from "./clients/http-factory.js";
import { createMockClients } from "./clients/mock.js";
import type { DownstreamClients } from "./clients/types.js";
import {
  createRedisLimiter,
  NoopLimiter,
  rateLimitPreHandler,
  type RateLimiter,
  type RedisLike,
} from "./rate-limit/limiter.js";
import { registerCorePlugins, registerVersionNegotiation } from "./plugins/core.js";
import { registerRoutes } from "./routes/index.js";
import { registerGraphQL } from "./graphql/index.js";

export interface ServerDeps {
  config?: AppConfig;
  clients?: DownstreamClients;
  metrics?: Metrics;
  tracing?: Tracing;
  limiter?: RateLimiter;
  jwtVerifier?: JwtVerifier;
  internalTokenIssuer?: InternalTokenIssuer;
  redis?: RedisLike;
}

export interface AppHandle {
  app: FastifyInstance;
  config: AppConfig;
  metrics: Metrics;
  tracing: Tracing;
  clients: DownstreamClients;
  limiter: RateLimiter;
  httpClients?: HttpClientFactory;
  readyz: () => Promise<{ status: string }>;
  shutdown: () => Promise<void>;
  installSignalHandlers: () => void;
}

export async function buildServer(deps: ServerDeps = {}): Promise<AppHandle> {
  const config = deps.config ?? loadConfig();
  const logger = createLogger(config);
  const metrics = deps.metrics ?? createMetrics(config.OTEL_SERVICE_NAME);
  const tracing = deps.tracing ?? createTracing(config);

  const internalTokenIssuer = deps.internalTokenIssuer ?? createInternalTokenIssuer("dev-internal-secret");
  const tokenProvider = () => internalTokenIssuer.issue({ sub: "api-gateway" });

  let clients: DownstreamClients;
  let httpClients: HttpClientFactory | undefined;
  if (deps.clients) {
    clients = deps.clients;
  } else if (config.NODE_ENV === "test" || config.RATE_LIMIT_REDIS_URL === "") {
    clients = createMockClients();
  } else {
    httpClients = createHttpClients({
      config,
      tokenProvider,
      traceProvider: () => tracing.inject(),
    });
    clients = httpClients;
  }

  const limiter = deps.limiter ?? (deps.redis ? createRedisLimiter(deps.redis) : NoopLimiter.instance);

  const jwtVerifier = deps.jwtVerifier ?? createJwtVerifier(config);
  const jwtAuthHook = jwtAuth(jwtVerifier) as preHandlerHookHandler;
  const partnerAuthHook = partnerApiKeyAuth({
    partnerRegistry: clients.partnerRegistry,
    headerName: config.PARTNER_API_KEY_HEADER,
    optional: true,
  }) as preHandlerHookHandler;

  const app = Fastify({
    logger: logger as never,
    disableRequestLogging: true,
    genReqId: () => cryptoRandom(),
  } as never);

  registerCorePlugins(app as never, { config, metrics, logger });
  registerVersionNegotiation(app as never);

  const rateLimitPreHook = rateLimitPreHandler(limiter, {
    onRejection: () => metrics.rateLimitRejectionsTotal.inc({ tier: "default" }),
  }) as preHandlerHookHandler;
  app.addHook("preHandler", rateLimitPreHook);

  const readyz = async () => {
    const checks: { name: string; ok: boolean }[] = [];
    if (deps.redis) {
      try {
        await deps.redis.ping();
        checks.push({ name: "redis", ok: true });
      } catch {
        checks.push({ name: "redis", ok: false });
      }
    }
    if (httpClients) {
      for (const s of httpClients.states()) {
        if (s.state === "open") checks.push({ name: s.service, ok: false });
      }
    }
    const allOk = checks.every((c) => c.ok);
    return { status: allOk ? "ok" : "degraded", checks };
  };

  registerRoutes({ app: app as never, clients, config, jwtAuth: jwtAuthHook, partnerAuth: partnerAuthHook, readyz });

  (app as never as { get: (path: string, handler: unknown) => void }).get("/metrics", async (_req: unknown, reply: { header: (k: string, v: string) => void; send: (b: string) => void }) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    reply.send(await metrics.registry.metrics());
  });

  if (config.ENABLE_GRAPHQL) {
    registerGraphQL(app as never, clients, jwtAuthHook as never);
  }

  const shutdown = async () => {
    const timer = setTimeout(() => process.exit(1), config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    await app.close();
    await tracing.shutdown();
    metrics.shutdown();
    clearTimeout(timer);
  };

  const installSignalHandlers = () => {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => {
        void shutdown();
      });
    }
    const memoryGuard = () => {
      const mem = process.memoryUsage();
      metrics.downstreamCircuitState; // touch to keep metrics referenced
      if (mem.rss > 1024 * 1024 * 1024) {
        app.log.warn({ rss: mem.rss }, "memory usage exceeds 1GB guard");
      }
    };
    setInterval(memoryGuard, 30_000).unref();
  };

  return { app: app as never, config, metrics, tracing, clients, limiter, httpClients, readyz, shutdown, installSignalHandlers };
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function start(handle: AppHandle, port?: number): AppHandle {
  const p = port ?? handle.config.PORT;
  handle.app.listen({ port: p, host: "0.0.0.0" }).catch((err) => {
    handle.app.log.error(err);
    process.exit(1);
  });
  return handle;
}

export async function main() {
  const handle = await buildServer();
  handle.installSignalHandlers();
  start(handle);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}