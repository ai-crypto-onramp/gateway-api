import crypto from "node:crypto";

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function extractOrGenerateRequestId(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-request-id"] ?? headers["request-id"];
  if (!raw) return newRequestId();
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return newRequestId();
  return v;
}

export function hashUserId(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

export function extractTraceparent(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers[TRACEPARENT_HEADER];
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}