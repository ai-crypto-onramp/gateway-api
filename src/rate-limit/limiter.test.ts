import { describe, it, expect } from "vitest";
import {
  createRedisLimiter,
  NoopLimiter,
  DEFAULT_TIERS,
  rateLimitPreHandler,
  pickLimitKey,
  tierFor,
} from "./limiter.js";
import type { AppConfig } from "../config.js";
import type { AuthPrincipal } from "../auth/index.js";

function makeRedis(items: Record<string, Record<string, string>> = {}): {
  redis: ReturnType<typeof makeRedis>;
  eval: (script: string, keys: number, ...args: (string | number)[]) => Promise<unknown[]>;
  ping: () => Promise<string>;
  store: Record<string, Record<string, string>>;
} {
  const store = items;
  return {
    store,
    async eval(_script: string, _keys: number, ...args: (string | number)[]) {
      const [key, capacityArg, refillArg, nowArg] = args as [string, number, number, number];
      const capacity = Number(capacityArg);
      const refill = Number(refillArg);
      const now = Number(nowArg);
      const cur = store[key] ?? {};
      let tokens = cur.tokens !== undefined ? Number(cur.tokens) : capacity;
      const ts = cur.ts !== undefined ? Number(cur.ts) : now;
      const elapsed = Math.max(0, now - ts);
      tokens = Math.min(capacity, tokens + elapsed * refill);
      let limited = 0;
      let remaining = tokens;
      if (tokens < 1) {
        limited = 1;
        remaining = 0;
      } else {
        tokens -= 1;
        remaining = tokens;
      }
      store[key] = { tokens: String(tokens), ts: String(now) };
      const resetIn = Math.ceil((capacity - tokens) / refill);
      const retryAfter = limited ? Math.ceil((1 - tokens) / refill) + 1 : 0;
      return [String(limited), String(remaining), String(capacity), String(resetIn), String(retryAfter)];
    },
    async ping() {
      return "PONG";
    },
    redis: undefined as never,
  };
}

describe("rate limiter", () => {
  it("noop limiter never limits", async () => {
    const res = await NoopLimiter.instance.consume("k", DEFAULT_TIERS.end_user);
    expect(res.limited).toBe(false);
  });

  it("redis limiter allows within burst then limits", async () => {
    const r = makeRedis();
    const lim = createRedisLimiter(r as never);
    const tier = { rps: 1, burst: 2 };
    const r1 = await lim.consume("k1", tier);
    const r2 = await lim.consume("k1", tier);
    const r3 = await lim.consume("k1", tier);
    expect(r1.limited).toBe(false);
    expect(r2.limited).toBe(false);
    expect(r3.limited).toBe(true);
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it("emits headers via preHandler when allowed", async () => {
    const r = makeRedis();
    const lim = createRedisLimiter(r as never);
    const headers: Record<string, string> = {};
    let rejected = 0;
    const pre = rateLimitPreHandler(lim, { onRejection: () => (rejected += 1) });
    const req = { ip: "1.2.3.4", principal: undefined } as never;
    const reply = {
      header: (k: string, v: string) => {
        headers[k] = v;
      },
    } as never;
    await expect(pre(req, reply)).resolves.toBeUndefined();
    expect(headers["X-RateLimit-Limit"]).toBe(String(DEFAULT_TIERS.ip.burst));
    expect(headers["X-RateLimit-Remaining"]).toBeTruthy();
    expect(rejected).toBe(0);
  });

  it("throws 429 when limited and increments counter", async () => {
    const r = makeRedis();
    const lim = createRedisLimiter(r as never);
    const headers: Record<string, string> = {};
    let rejected = 0;
    const pre = rateLimitPreHandler(lim, { onRejection: () => (rejected += 1) });
    const req = { ip: "1.2.3.4", principal: undefined } as never;
    const reply = {
      header: (k: string, v: string) => {
        headers[k] = v;
      },
    } as never;
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    await pre(req, reply);
    try {
      await pre(req, reply);
    } catch (err) {
      expect((err as { status: number }).status).toBe(429);
      expect((err as { headers: Record<string, string> }).headers["Retry-After"]).toBeTruthy();
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it("pickLimitKey selects partner tier", () => {
    const req = {
      principal: { kind: "partner", partnerId: "p1", identity: "p1", scopes: new Set() } as AuthPrincipal,
    } as never;
    const { key, tier } = pickLimitKey(req);
    expect(key).toContain("partner:p1");
    expect(tier.rps).toBe(DEFAULT_TIERS.partner.rps);
  });

  it("pickLimitKey falls back to ip", () => {
    const req = { ip: "9.9.9.9" } as never;
    const { key, tier } = pickLimitKey(req);
    expect(key).toContain("ip:9.9.9.9");
    expect(tier.rps).toBe(DEFAULT_TIERS.ip.rps);
  });

  it("tierFor honors config override", () => {
    const cfg = {
      RATE_LIMIT_TIER_PARTNER: { rps: 999, burst: 1 },
    } as unknown as AppConfig;
    const p = { kind: "partner" } as AuthPrincipal;
    expect(tierFor(p, cfg).rps).toBe(999);
  });
});