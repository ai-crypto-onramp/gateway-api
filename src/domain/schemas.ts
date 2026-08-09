import { z } from "zod";

export const AuthSessionRequestSchema = z
  .object({
    grantType: z.enum(["refresh_token", "authorization_code"]),
    refreshToken: z.string().optional(),
    authorizationCode: z.string().optional(),
    codeVerifier: z.string().optional(),
  })
  .refine(
    (v) =>
      (v.grantType === "refresh_token" && !!v.refreshToken) ||
      (v.grantType === "authorization_code" && !!v.authorizationCode),
    { message: "missing required credential for grantType" },
  );

export const AuthSessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  scope: z.string().optional(),
});

export const UserProfileSchema = z.object({
  userId: z.string(),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  displayName: z.string().optional(),
  locale: z.string().optional(),
});

export const KycStatusEnum = z.enum(["not_started", "pending", "in_review", "approved", "rejected"]);
export type KycStatus = z.infer<typeof KycStatusEnum>;

export const KycStatusResponseSchema = z.object({
  userId: z.string(),
  status: KycStatusEnum,
  referenceId: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
  reasons: z.array(z.string()).optional(),
});

export const MeResponseSchema = z.object({
  user: UserProfileSchema,
  kyc: KycStatusResponseSchema,
});

export const QuoteRequestSchema = z.object({
  baseCurrency: z.string().length(3),
  quoteCurrency: z.string().length(3),
  baseAmount: z.string().regex(/^\d+(\.\d+)?$/),
  paymentMethod: z.enum(["card", "bank_transfer", "wallet"]),
  lockWindowSeconds: z.number().int().positive().max(600).optional(),
  partnerId: z.string().optional(),
});

export const QuoteResponseSchema = z.object({
  quoteId: z.string(),
  baseCurrency: z.string().length(3),
  quoteCurrency: z.string().length(3),
  baseAmount: z.string(),
  quoteAmount: z.string(),
  rate: z.string(),
  expiresAt: z.string().datetime(),
  paymentMethod: z.enum(["card", "bank_transfer", "wallet"]),
  fees: z.object({
    network: z.string(),
    partner: z.string(),
    total: z.string(),
  }),
});

export const TransactionStatusEnum = z.enum([
  "pending",
  "pending_payment",
  "pending_kyc",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type TransactionStatus = z.infer<typeof TransactionStatusEnum>;

export const InitiateTransactionRequestSchema = z.object({
  quoteId: z.string(),
  paymentMethod: z.enum(["card", "bank_transfer", "wallet"]),
  paymentInstrumentToken: z.string().optional(),
  partnerId: z.string().optional(),
});

export const TransactionResponseSchema = z.object({
  transactionId: z.string(),
  status: TransactionStatusEnum,
  quoteId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  failureReason: z.string().optional(),
  redirectUrl: z.string().url().optional(),
});

export const TransactionDetailResponseSchema = TransactionResponseSchema.extend({
  ledger: z
    .object({
      debited: z.boolean().optional(),
      credited: z.boolean().optional(),
      txHash: z.string().optional(),
    })
    .optional(),
});

export const PaginationSchema = z.object({
  cursor: z.string().nullable(),
  hasNext: z.boolean(),
  limit: z.number().int().positive(),
});

export const TransactionListResponseSchema = z.object({
  items: z.array(TransactionResponseSchema),
  pagination: PaginationSchema,
});

export const KycStartRequestSchema = z.object({
  flow: z.enum(["standard", "document", "liveness"]).default("standard"),
  redirectUrl: z.string().url().optional(),
});

export const KycStartResponseSchema = z.object({
  referenceId: z.string(),
  status: KycStatusEnum,
  redirectUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});

export const PartnerWebhookEventEnum = z.enum([
  "transaction.completed",
  "transaction.failed",
  "kyc.approved",
  "kyc.rejected",
  "quote.expired",
]);
export type PartnerWebhookEvent = z.infer<typeof PartnerWebhookEventEnum>;

export const PartnerWebhookRegistrationSchema = z.object({
  url: z.string().url(),
  events: z.array(PartnerWebhookEventEnum).min(1),
  description: z.string().optional(),
});

export const PartnerWebhookRegistrationResponseSchema = z.object({
  webhookId: z.string(),
  url: z.string().url(),
  events: z.array(PartnerWebhookEventEnum),
  createdAt: z.string().datetime(),
});

export const ProblemSchema = z.object({
  type: z.string().url().or(z.string()),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  traceId: z.string().optional(),
  errors: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .optional(),
});

export type AuthSessionRequest = z.infer<typeof AuthSessionRequestSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type KycStatusResponse = z.infer<typeof KycStatusResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
export type InitiateTransactionRequest = z.infer<typeof InitiateTransactionRequestSchema>;
export type TransactionResponse = z.infer<typeof TransactionResponseSchema>;
export type TransactionDetailResponse = z.infer<typeof TransactionDetailResponseSchema>;
export type TransactionListResponse = z.infer<typeof TransactionListResponseSchema>;
export type KycStartRequest = z.infer<typeof KycStartRequestSchema>;
export type KycStartResponse = z.infer<typeof KycStartResponseSchema>;
export type PartnerWebhookRegistration = z.infer<typeof PartnerWebhookRegistrationSchema>;
export type PartnerWebhookRegistrationResponse = z.infer<typeof PartnerWebhookRegistrationResponseSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;