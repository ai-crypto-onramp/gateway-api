import { request, type Dispatcher } from "undici";
import CircuitBreaker from "opossum";
import type { AppConfig } from "../config.js";

export interface DownstreamRequestOpts {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  idempotent?: boolean;
  headers?: Record<string, string>;
  cacheKey?: string;
}

export interface DownstreamResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  cached?: boolean;
}

export interface ServiceTokenProvider {
  (): Promise<string> | string;
}

export interface TraceContextProvider {
  (): Record<string, string>;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

export class DownstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly cause?: unknown,
    public readonly timedOut = false,
  ) {
    super(`${service} responded ${status}`);
    this.name = "DownstreamError";
  }
}

export interface DownstreamClientOptions {
  service: string;
  baseUrl: string;
  config: AppConfig;
  tokenProvider?: ServiceTokenProvider;
  traceProvider?: TraceContextProvider;
  cache?: CacheStore;
  maxRetries?: number;
  cacheTtlMs?: number;
  bulkhead?: number;
}

export class DownstreamClient {
  private breaker: CircuitBreaker;
  private cacheTtlMs: number;
  private maxRetries: number;

  constructor(private opts: DownstreamClientOptions) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    this.maxRetries = opts.maxRetries ?? 0;
    this.breaker = new CircuitBreaker(
      async (req: DownstreamRequestOpts) => this.doRequest(req),
      {
        timeout: opts.config.DOWNSTREAM_TIMEOUT_MS,
        errorThresholdPercentage: opts.config.CIRCUIT_BREAKER_THRESHOLD,
        resetTimeout: 30_000,
        volumeThreshold: opts.bulkhead ?? 5,
        rollingCountTimeout: 30_000,
        name: opts.service,
      },
    );
  }

  get circuitState(): string {
    return this.breaker.opened ? "open" : this.breaker.closed ? "closed" : "half-open";
  }

  get breakerMetrics() {
    return {
      name: this.opts.service,
      state: this.circuitState,
      rejected: this.breaker.stats.rejects,
      failures: this.breaker.stats.failures,
      fired: this.breaker.stats.fires,
    };
  }

  async request<T>(reqOpts: DownstreamRequestOpts): Promise<DownstreamResponse<T>> {
    if (!this.breaker.closed) {
      if (reqOpts.cacheKey && this.opts.cache && this.cacheTtlMs > 0) {
        const cached = await this.opts.cache.get<T>(reqOpts.cacheKey);
        if (cached) return { status: 200, body: cached, headers: {}, cached: true } as DownstreamResponse<T>;
      }
      throw new DownstreamError(this.opts.service, 503, "circuit open");
    }
    const attempts = reqOpts.idempotent ? this.maxRetries + 1 : 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = (await this.breaker.fire(reqOpts)) as DownstreamResponse<T>;
        if (reqOpts.cacheKey && this.opts.cache && this.cacheTtlMs > 0) {
          await this.opts.cache.set(reqOpts.cacheKey, res.body, this.cacheTtlMs);
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (err instanceof DownstreamError && (err.timedOut || err.status >= 500)) {
          if (attempt < attempts - 1) {
            await this.jitter();
            continue;
          }
        }
        if (err instanceof DownstreamError) throw err;
        const de = err as { code?: string };
        if (de?.code === "ETIMEDOUT" || de?.code === "UND_ERR_HEADERS_TIMEOUT" || de?.code === "UND_ERR_BODY_TIMEOUT") {
          throw new DownstreamError(this.opts.service, 504, "timeout", err, true);
        }
        throw err;
      }
    }
    throw lastErr ?? new DownstreamError(this.opts.service, 500, "unknown");
  }

  private async jitter(): Promise<void> {
    const wait = Math.floor(Math.random() * 100) + 50;
    await new Promise((r) => setTimeout(r, wait));
  }

  private async doRequest(req: DownstreamRequestOpts): Promise<DownstreamResponse<unknown>> {
    const url = new URL(req.path, this.opts.baseUrl).toString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...(req.headers ?? {}),
    };
    const token = await Promise.resolve(this.opts.tokenProvider?.());
    if (token) headers["x-internal-token"] = token;
    if (this.opts.traceProvider) {
      for (const [k, v] of Object.entries(this.opts.traceProvider())) headers[k] = v;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.config.DOWNSTREAM_TIMEOUT_MS,
    );
    try {
      const res = await request(url, {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      } as Dispatcher.RequestOptions);
      if (res.statusCode >= 400) {
        const text = await res.body.text().catch(() => "");
        throw new DownstreamError(this.opts.service, res.statusCode, text);
      }
      const body = await res.body.json().catch(() => ({}));
      return { status: res.statusCode, body, headers: res.headers as Record<string, string | string[] | undefined> };
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name === "AbortError") throw new DownstreamError(this.opts.service, 504, "timeout", err, true);
      if (err instanceof DownstreamError) throw err;
      throw new DownstreamError(this.opts.service, 502, "request failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
}