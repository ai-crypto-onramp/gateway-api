import crypto from "node:crypto";
import type { PartnerWebhookEvent } from "../domain/schemas.js";

export interface WebhookPayload {
  eventId: string;
  event: PartnerWebhookEvent;
  occurredAt: string;
  partnerId: string;
  data: unknown;
}

export interface WebhookSignerOpts {
  secret: string;
  toleranceMs?: number;
}

export interface SignedWebhook {
  payload: WebhookPayload;
  body: string;
  signature: string;
  timestamp: number;
}

export class WebhookSigner {
  constructor(private opts: WebhookSignerOpts) {}

  sign(payload: WebhookPayload): SignedWebhook {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(payload);
    const sig = this.compute(body, timestamp);
    return { payload, body, signature: sig, timestamp };
  }

  verify(body: string, signature: string, timestamp: number, now = Date.now()): boolean {
    const tolerance = this.opts.toleranceMs ?? 5 * 60 * 1000;
    if (Math.abs(now - timestamp * 1000) > tolerance) return false;
    const expected = this.compute(body, timestamp);
    return safeEqual(expected, signature);
  }

  private compute(body: string, timestamp: number): string {
    const data = `${timestamp}.${body}`;
    return crypto.createHmac("sha256", this.opts.secret).update(data).digest("hex");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function isValidWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1" || /^[0-9.]+$/.test(host)) return true;
    return !host.endsWith(".internal") && !host.endsWith(".local");
  } catch {
    return false;
  }
}

export function newEventId(): string {
  return crypto.randomUUID();
}