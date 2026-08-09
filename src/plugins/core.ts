import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { ApiError } from "../domain/errors.js";
import { extractOrGenerateRequestId, hashUserId } from "../domain/request-id.js";
import type { Metrics } from "../observability/metrics.js";
import type { Logger } from "pino";

export interface PluginDeps {
  config: AppConfig;
  metrics: Metrics;
  logger: Logger;
}

export function registerCorePlugins(app: FastifyInstance, deps: PluginDeps) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = extractOrGenerateRequestId(req.headers as Record<string, string | string[] | undefined>);
    req.id = requestId;
    reply.header("x-request-id", requestId);
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const start = (req as unknown as { startTime?: number }).startTime ?? Date.now();
    const dur = (Date.now() - start) / 1000;
    const route = req.routeOptions?.url ?? req.routerPath ?? "unknown";
    const method = req.method;
    const status = String(reply.statusCode);
    const labels = { method, route, status };
    try {
      deps.metrics.httpRequestsTotal.inc(labels);
      deps.metrics.httpRequestDurationSeconds.observe({ method, route }, dur);
      if (reply.statusCode >= 500) deps.metrics.httpRequestsErrorsTotal.inc(labels);
    } catch {
      // ignore metric errors
    }
    const principal = req.principal as { userId?: string } | undefined;
    deps.logger.info({
      requestId: req.id,
      method,
      route,
      status,
      latencyMs: Math.round(dur * 1000),
      userId: principal?.userId ? hashUserId(principal.userId) : undefined,
    });
  });

  app.setErrorHandler((err: Error, req: FastifyRequest, reply: FastifyReply) => {
    let apiError: ApiError;
    if (err instanceof ApiError) {
      apiError = err;
    } else if ((err as { validation?: unknown }).validation) {
      apiError = new ApiError("invalid_request", err.message, {
        status: 400,
        details: (err as unknown as { validation: { field?: string; message?: string }[] }).validation?.map((v) => ({
          field: v.field ?? "",
          message: v.message ?? "",
        })),
      });
    } else {
      apiError = new ApiError("internal_error", err.message, { cause: err });
      deps.logger.error({ err, requestId: req.id }, "unhandled error");
    }
    const status = apiError.status;
    if (apiError.headers) {
      for (const [k, v] of Object.entries(apiError.headers)) reply.header(k, v);
    }
    reply.code(status).send(apiError.toProblem(req.id));
  });

  registerCors(app, deps.config);
  registerSecurityHeaders(app, deps.config);
}

export function registerCors(app: FastifyInstance, config: AppConfig) {
  const origins = config.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("access-control-allow-headers", "authorization, content-type, x-request-id, idempotency-key, x-api-key, traceparent");
      reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });
}

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig) {
  void config;
  app.addHook("onRequest", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
  });
}

const DEPRECATED_ROUTES = new Set<string>(["/v1/auth/session"]);

export function registerVersionNegotiation(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const apiVersion = req.headers["x-api-version"] as string | undefined;
    if (apiVersion) {
      if (apiVersion === "1") {
        // ok
      } else if (apiVersion === "2") {
        reply.header("sunset", "Sun, 01 Jan 2099 00:00:00 GMT");
        reply.header("link", '</v1>; rel="successor-version"');
      } else {
        throw new ApiError("invalid_request", `unsupported api version ${apiVersion}`, { status: 400 });
      }
    }
    if (req.routerPath && DEPRECATED_ROUTES.has(req.routerPath)) {
      reply.header("deprecation", "true");
      reply.header("link", '</v2/auth/session>; rel="successor-version"');
    }
  });
}