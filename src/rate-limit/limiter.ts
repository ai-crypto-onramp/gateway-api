import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { ApiError } from "../domain/errors.js";
import type { AuthPrincipal } from "../auth/index.js";

export interface RateLimitTier {
  rps: number;
  burst: number;
}

export const DEFAULT_TIERS: Record<"end_user" | "partner" | "ip", RateLimitTier> = {
  end_user: { rps: 10, burst: 20 },
  partner: { rps: 100, burst: 200 },
  ip: { rps: 5, burst: 10 },
};

export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  limit: number;
  reset: number;
  retryAfter: number;
}

export interface RateLimiter {
  consume(key: string, tier: RateLimitTier): Promise<RateLimitResult>;
}

const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = math.ceil(capacity / refill) + 1
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill)
local limited = 0
local remaining = tokens
if tokens < 1 then
  limited = 1
  remaining = 0
else
  tokens = tokens - 1
  remaining = tokens
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
local reset_in = math.ceil((capacity - tokens) / refill)
local retry_after = limited and math.ceil((1 - tokens) / refill) + 1 or 0
return {limited, remaining, capacity, reset_in, retry_after}
`;

export interface RedisLike {
  eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown[]>;
  ping(): Promise<string>;
}

export function createRedisLimiter(redis: RedisLike): RateLimiter {
  return {
    async consume(key, tier) {
      const now = Math.floor(Date.now() / 1000);
      const res = (await redis.eval(LUA, 1, key, tier.burst, tier.rps, now)) as string[];
      const [limited, remaining, limit, reset, retryAfter] = res.map(Number);
      return {
        limited: limited === 1,
        remaining,
        limit,
        reset: now + reset,
        retryAfter: retryAfter,
      };
    },
  };
}

export class NoopLimiter implements RateLimiter {
  async consume(_key?: string, _tier?: RateLimitTier): Promise<RateLimitResult> {
    return { limited: false, remaining: Infinity, limit: Infinity, reset: 0, retryAfter: 0 };
  }
  static instance = new NoopLimiter();
}

export function pickLimitKey(req: FastifyRequest): { key: string; tier: RateLimitTier } {
  const p = req.principal as AuthPrincipal | undefined;
  if (p?.kind === "partner" && p.partnerId) {
    return { key: `rl:partner:${p.partnerId}`, tier: DEFAULT_TIERS.partner };
  }
  if (p?.kind === "user" && p.userId) {
    return { key: `rl:user:${p.userId}`, tier: DEFAULT_TIERS.end_user };
  }
  const ip = (req.ip as string) ?? "anonymous";
  return { key: `rl:ip:${ip}`, tier: DEFAULT_TIERS.ip };
}

export interface RateLimitHooks {
  onRejection?(): void;
}

export function rateLimitPreHandler(limiter: RateLimiter, hooks: RateLimitHooks = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { key, tier } = pickLimitKey(req);
    const res = await limiter.consume(key, tier);
    reply.header("X-RateLimit-Limit", String(res.limit === Infinity ? tier.burst : res.limit));
    reply.header("X-RateLimit-Remaining", String(res.remaining === Infinity ? tier.burst : res.remaining));
    reply.header("X-RateLimit-Reset", String(res.reset));
    if (res.limited) {
      reply.header("Retry-After", String(res.retryAfter || 1));
      hooks.onRejection?.();
      throw new ApiError("rate_limited", "rate limit exceeded", {
        status: 429,
        headers: { "Retry-After": String(res.retryAfter || 1) },
      });
    }
  };
}

export function tierFor(principal: AuthPrincipal | undefined, cfg: AppConfig): RateLimitTier {
  if (principal?.kind === "partner") {
    return cfg.RATE_LIMIT_TIER_PARTNER ?? DEFAULT_TIERS.partner;
  }
  if (principal?.kind === "user") {
    return cfg.RATE_LIMIT_TIER_END_USER ?? DEFAULT_TIERS.end_user;
  }
  return DEFAULT_TIERS.ip;
}