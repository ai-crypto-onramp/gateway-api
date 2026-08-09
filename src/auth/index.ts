import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { createRemoteJWKSet } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { ApiError } from "../domain/errors.js";
import type { Scope } from "../domain/scopes.js";
import type { PartnerRegistryClient } from "../clients/types.js";

export interface AuthPrincipal {
  kind: "user" | "partner" | "internal";
  userId?: string;
  partnerId?: string;
  identity: string;
  scopes: Set<Scope>;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
}

export interface JwtVerifier {
  verify(token: string): Promise<JWTPayload & { sub?: string; scope?: string }>;
  refreshCount(): number;
}

export function createJwtVerifier(config: AppConfig): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(config.JWKS_URL));
  let refreshCount = 0;
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
        });
        return payload as JWTPayload & { sub?: string; scope?: string };
      } catch {
        refreshCount += 1;
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
        });
        return payload as JWTPayload & { sub?: string; scope?: string };
      }
    },
    refreshCount() {
      return refreshCount;
    },
  };
}

export function parseScopes(scope: string | undefined): Set<Scope> {
  if (!scope) return new Set();
  return new Set(scope.split(" ").filter(Boolean) as Scope[]);
}

export function requireScopes(...required: Scope[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const p = req.principal;
    if (!p) throw new ApiError("unauthorized", "authentication required");
    const missing = required.filter((s) => !p.scopes.has(s));
    if (missing.length > 0) throw new ApiError("forbidden", `missing scopes: ${missing.join(", ")}`);
  };
}

export interface InternalTokenIssuer {
  issue(payload: Record<string, unknown>): Promise<string>;
}

export function createInternalTokenIssuer(secret: string): InternalTokenIssuer {
  const encoder = new TextEncoder();
  const key = encoder.encode(secret);
  return {
    issue(payload) {
      return new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt().setExpirationTime("5m").sign(key);
    },
  };
}

export interface PartnerAuthOptions {
  partnerRegistry: PartnerRegistryClient;
  headerName: string;
  optional?: boolean;
}

export function partnerApiKeyAuth(opts: PartnerAuthOptions) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers[opts.headerName.toLowerCase()];
    const apiKey = Array.isArray(key) ? key[0] : key;
    if (!apiKey) {
      if (opts.optional) return;
      throw new ApiError("unauthorized", "missing api key");
    }
    const result = await opts.partnerRegistry.verifyApiKey(apiKey);
    if (!result) {
      reply.code(401);
      throw new ApiError("unauthorized", "invalid api key");
    }
    req.principal = {
      kind: "partner",
      partnerId: result.partnerId,
      identity: result.identity,
      scopes: new Set<Scope>(["partner:webhooks", "quotes:write", "tx:read"]),
    };
  };
}

export function jwtAuth(verifier: JwtVerifier) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new ApiError("unauthorized", "missing bearer token");
    }
    const token = auth.slice(7);
    let payload: JWTPayload & { sub?: string; scope?: string };
    try {
      payload = await verifier.verify(token);
    } catch {
      throw new ApiError("unauthorized", "invalid token");
    }
    req.principal = {
      kind: "user",
      userId: payload.sub,
      identity: payload.sub ?? "",
      scopes: parseScopes(payload.scope),
    };
  };
}