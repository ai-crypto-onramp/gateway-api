import { describe, it, expect } from "vitest";
import { WebhookSigner, isValidWebhookUrl, newEventId } from "./signing.js";

describe("webhooks", () => {
  const signer = new WebhookSigner({ secret: "shh" });

  it("signs and verifies payload", () => {
    const signed = signer.sign({
      eventId: newEventId(),
      event: "transaction.completed",
      occurredAt: new Date().toISOString(),
      partnerId: "p1",
      data: { txId: "t1" },
    });
    expect(signer.verify(signed.body, signed.signature, signed.timestamp)).toBe(true);
  });

  it("rejects tampered payload", () => {
    const signed = signer.sign({
      eventId: "e1",
      event: "transaction.completed",
      occurredAt: "2024-01-01T00:00:00Z",
      partnerId: "p1",
      data: { v: 1 },
    });
    expect(signer.verify(signed.body + "x", signed.signature, signed.timestamp)).toBe(false);
  });

  it("rejects replay beyond tolerance", () => {
    const signed = signer.sign({
      eventId: "e1",
      event: "kyc.approved",
      occurredAt: "2024-01-01T00:00:00Z",
      partnerId: "p1",
      data: {},
    });
    const oldTime = signed.timestamp - 60 * 60;
    expect(signer.verify(signed.body, signed.signature, oldTime, Date.now())).toBe(false);
  });

  it("validates webhook URLs", () => {
    expect(isValidWebhookUrl("https://partner.example.com/hooks")).toBe(true);
    expect(isValidWebhookUrl("http://localhost:9000/hooks")).toBe(true);
    expect(isValidWebhookUrl("ftp://x.com")).toBe(false);
    expect(isValidWebhookUrl("http://svc.internal/hooks")).toBe(false);
    expect(isValidWebhookUrl("not-a-url")).toBe(false);
  });
});