import { describe, it, expect } from "vitest";
import {
  AuthSessionRequestSchema,
  AuthSessionResponseSchema,
  MeResponseSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  InitiateTransactionRequestSchema,
  TransactionResponseSchema,
  TransactionDetailResponseSchema,
  TransactionListResponseSchema,
  KycStartRequestSchema,
  KycStartResponseSchema,
  PartnerWebhookRegistrationSchema,
} from "./schemas.js";
import { mapSagaStateToClient, sagaFailureReason } from "./status-mapping.js";
import { ApiError, defaultStatus } from "./errors.js";
import { isValidIdempotencyKey, parseIdempotencyKey, newIdempotencyKey } from "./idempotency.js";
import { extractOrGenerateRequestId, hashUserId, newRequestId, extractTraceparent } from "./request-id.js";
import { paginate } from "./pagination.js";

describe("schemas", () => {
  it("auth session valid refresh", () => {
    const r = AuthSessionRequestSchema.safeParse({
      grantType: "refresh_token",
      refreshToken: "abc",
    });
    expect(r.success).toBe(true);
  });
  it("auth session invalid missing credential", () => {
    const r = AuthSessionRequestSchema.safeParse({ grantType: "refresh_token" });
    expect(r.success).toBe(false);
  });
  it("auth session response valid", () => {
    expect(
      AuthSessionResponseSchema.safeParse({
        accessToken: "a",
        refreshToken: "r",
        tokenType: "Bearer",
        expiresIn: 3600,
      }).success,
    ).toBe(true);
  });
  it("me response", () => {
    expect(
      MeResponseSchema.safeParse({
        user: { userId: "u1" },
        kyc: { userId: "u1", status: "approved" },
      }).success,
    ).toBe(true);
  });
  it("quote request", () => {
    expect(
      QuoteRequestSchema.safeParse({
        baseCurrency: "USD",
        quoteCurrency: "ETH",
        baseAmount: "100.00",
        paymentMethod: "card",
      }).success,
    ).toBe(true);
  });
  it("quote request rejects negative lock window", () => {
    expect(
      QuoteRequestSchema.safeParse({
        baseCurrency: "USD",
        quoteCurrency: "ETH",
        baseAmount: "100",
        paymentMethod: "card",
        lockWindowSeconds: -1,
      }).success,
    ).toBe(false);
  });
  it("quote response", () => {
    expect(
      QuoteResponseSchema.safeParse({
        quoteId: "q1",
        baseCurrency: "USD",
        quoteCurrency: "ETH",
        baseAmount: "100",
        quoteAmount: "0.05",
        rate: "0.0005",
        expiresAt: "2024-01-01T00:00:00Z",
        paymentMethod: "card",
        fees: { network: "1", partner: "0", total: "1" },
      }).success,
    ).toBe(true);
  });
  it("initiate transaction request", () => {
    expect(
      InitiateTransactionRequestSchema.safeParse({
        quoteId: "q1",
        paymentMethod: "card",
      }).success,
    ).toBe(true);
  });
  it("transaction response", () => {
    expect(
      TransactionResponseSchema.safeParse({
        transactionId: "t1",
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });
  it("transaction detail response with ledger", () => {
    expect(
      TransactionDetailResponseSchema.safeParse({
        transactionId: "t1",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
        ledger: { debited: true, credited: true, txHash: "0xabc" },
      }).success,
    ).toBe(true);
  });
  it("transaction list response", () => {
    expect(
      TransactionListResponseSchema.safeParse({
        items: [{ transactionId: "t1", status: "pending", createdAt: "2024-01-01T00:00:00Z" }],
        pagination: { cursor: null, hasNext: false, limit: 20 },
      }).success,
    ).toBe(true);
  });
  it("kyc start request defaults flow", () => {
    const r = KycStartRequestSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.flow).toBe("standard");
  });
  it("kyc start response", () => {
    expect(
      KycStartResponseSchema.safeParse({
        referenceId: "k1",
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });
  it("partner webhook registration", () => {
    expect(
      PartnerWebhookRegistrationSchema.safeParse({
        url: "https://partner.example.com/hooks",
        events: ["transaction.completed"],
      }).success,
    ).toBe(true);
  });
  it("partner webhook registration rejects empty events", () => {
    expect(
      PartnerWebhookRegistrationSchema.safeParse({
        url: "https://partner.example.com/hooks",
        events: [],
      }).success,
    ).toBe(false);
  });
});

describe("saga state mapping", () => {
  it("maps all known saga states", () => {
    const cases: [string, string][] = [
      ["INITIATED", "pending"],
      ["PAYMENT_PENDING", "pending_payment"],
      ["KYC_PENDING", "pending_kyc"],
      ["EXECUTING", "processing"],
      ["SETTLED", "completed"],
      ["CANCELLED", "cancelled"],
      ["EXPIRED", "expired"],
      ["PAYMENT_FAILED", "failed"],
      ["KYC_FAILED", "failed"],
      ["EXECUTION_FAILED", "failed"],
    ];
    for (const [saga, expected] of cases) {
      expect(mapSagaStateToClient(saga as never)).toBe(expected);
    }
  });
  it("unknown saga defaults to pending", () => {
    expect(mapSagaStateToClient("UNKNOWN_STATE" as never)).toBe("pending");
  });
  it("sagaFailureReason returns reason on failures", () => {
    expect(sagaFailureReason("PAYMENT_FAILED")).toBe("payment_failed");
    expect(sagaFailureReason("KYC_FAILED")).toBe("kyc_failed");
    expect(sagaFailureReason("EXECUTION_FAILED")).toBe("execution_failed");
    expect(sagaFailureReason("SETTLED")).toBeUndefined();
  });
});

describe("ApiError", () => {
  it("maps to default status per code", () => {
    expect(defaultStatus("invalid_request")).toBe(400);
    expect(defaultStatus("unauthorized")).toBe(401);
    expect(defaultStatus("forbidden")).toBe(403);
    expect(defaultStatus("rate_limited")).toBe(429);
    expect(defaultStatus("downstream_timeout")).toBe(504);
    expect(defaultStatus("downstream_circuit_open")).toBe(503);
    expect(defaultStatus("internal_error")).toBe(500);
  });
  it("toProblem includes traceId and details", () => {
    const e = new ApiError("invalid_request", "bad input", {
      details: [{ field: "x", message: "required" }],
    });
    const p = e.toProblem("trace-1");
    expect(p.code).toBe("invalid_request");
    expect(p.status).toBe(400);
    expect(p.traceId).toBe("trace-1");
    expect(p.errors).toEqual([{ field: "x", message: "required" }]);
  });
  it("rate_limited carries headers", () => {
    const e = new ApiError("rate_limited", "too many", {
      headers: { "Retry-After": "1" },
    });
    expect(e.headers?.["Retry-After"]).toBe("1");
    expect(e.status).toBe(429);
  });
});

describe("idempotency-key", () => {
  it("validates printable keys", () => {
    expect(isValidIdempotencyKey("abc-123_xyz.0:1")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("space here")).toBe(false);
    expect(isValidIdempotencyKey("a".repeat(256))).toBe(false);
  });
  it("parses from headers", () => {
    expect(parseIdempotencyKey({ "idempotency-key": "key-1" })).toBe("key-1");
    expect(parseIdempotencyKey({ "idempotency-key": ["key-2"] })).toBe("key-2");
    expect(parseIdempotencyKey({ "idempotency-key": "bad space" })).toBeNull();
    expect(parseIdempotencyKey({})).toBeNull();
  });
  it("generates a key", () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]+$/);
  });
});

describe("request-id", () => {
  it("extracts or generates", () => {
    expect(extractOrGenerateRequestId({ "x-request-id": "abc" })).toBe("abc");
    expect(extractOrGenerateRequestId({ "request-id": ["xyz"] })).toBe("xyz");
    expect(extractOrGenerateRequestId({})).toMatch(/^[0-9a-f-]+$/);
    expect(newRequestId()).toMatch(/^[0-9a-f-]+$/);
  });
  it("hashes user id", () => {
    expect(hashUserId("u1")).toBe(hashUserId("u1"));
    expect(hashUserId("u1")).not.toBe("u1");
  });
  it("extractTraceparent returns first value", () => {
    expect(extractTraceparent({ traceparent: "00-x-x-01" })).toBe("00-x-x-01");
    expect(extractTraceparent({ traceparent: ["00-y-y-02"] })).toBe("00-y-y-02");
    expect(extractTraceparent({})).toBeUndefined();
  });
});

describe("pagination", () => {
  const items = [
    { id: "a", createdAt: "1" },
    { id: "b", createdAt: "2" },
    { id: "c", createdAt: "3" },
  ];
  it("returns first page", () => {
    const r = paginate(items, 2);
    expect(r.items.length).toBe(2);
    expect(r.pagination.hasNext).toBe(true);
    expect(r.pagination.cursor).toBe("b");
  });
  it("returns next page from cursor", () => {
    const r = paginate(items, 2, "b");
    expect(r.items[0].id).toBe("c");
    expect(r.pagination.hasNext).toBe(false);
    expect(r.pagination.cursor).toBeNull();
  });
  it("handles unknown cursor", () => {
    const r = paginate(items, 10, "nope");
    expect(r.items.length).toBe(3);
    expect(r.pagination.hasNext).toBe(false);
  });
});