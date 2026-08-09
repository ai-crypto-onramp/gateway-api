import crypto from "node:crypto";

const MAX_LEN = 255;

export function isValidIdempotencyKey(key: string): boolean {
  if (!key) return false;
  if (key.length > MAX_LEN) return false;
  const printable = /^[A-Za-z0-9._\-:]+$/;
  return printable.test(key);
}

export function parseIdempotencyKey(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["idempotency-key"];
  if (!raw) return null;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !isValidIdempotencyKey(v)) return null;
  return v;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}