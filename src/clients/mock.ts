import type { DownstreamClients } from "./types.js";

export interface MockData {
  sessions?: Record<string, string>;
  users?: Record<string, unknown>;
  quotes?: Record<string, unknown>;
  transactions?: Record<string, unknown>;
  kyc?: Record<string, unknown>;
  webhooks?: Record<string, unknown>;
  apiKeys?: Record<string, { partnerId: string; identity: string }>;
}

export function createMockClients(data: MockData = {}): DownstreamClients {
  return {
    identityAuth: {
      async exchangeSession(req) {
        if (req.grantType === "refresh_token") {
          const refreshToken = req.refreshToken ?? "";
          const accessToken = data.sessions?.[refreshToken] ?? "mock-access-token";
          return {
            accessToken,
            refreshToken,
            tokenType: "Bearer",
            expiresIn: 3600,
          };
        }
        return {
          accessToken: "mock-access-token",
          refreshToken: "mock-refresh-token",
          tokenType: "Bearer",
          expiresIn: 3600,
        };
      },
      async getProfile(userId: string) {
        const stored = data.users?.[userId] as
          | { email?: string; displayName?: string; emailVerified?: boolean; locale?: string }
          | undefined;
        return {
          userId,
          email: stored?.email,
          emailVerified: stored?.emailVerified,
          displayName: stored?.displayName,
          locale: stored?.locale,
        };
      },
    },
    kyc: {
      async getStatus(userId: string) {
        const stored = data.kyc?.[userId] as { status?: string; referenceId?: string } | undefined;
        return {
          userId,
          status: (stored?.status as "not_started" | "pending" | "approved" | "rejected" | "in_review") ?? "not_started",
          referenceId: stored?.referenceId,
        };
      },
      async start(userId: string, req) {
        return {
          referenceId: `kyc-${userId}`,
          status: "pending",
          redirectUrl: req.redirectUrl,
          createdAt: new Date().toISOString(),
        };
      },
    },
    pricing: {
      async createQuote(req) {
        const base = parseFloat(req.baseAmount);
        const rate = "0.0005";
        const quoteAmount = (base * parseFloat(rate)).toFixed(6);
        return {
          quoteId: `q-${Date.now()}`,
          baseCurrency: req.baseCurrency,
          quoteCurrency: req.quoteCurrency,
          baseAmount: req.baseAmount,
          quoteAmount,
          rate,
          expiresAt: new Date(Date.now() + (req.lockWindowSeconds ?? 60) * 1000).toISOString(),
          paymentMethod: req.paymentMethod,
          fees: { network: "1.00", partner: "0.00", total: "1.00" },
        };
      },
    },
    orchestrator: {
      async initiate(req) {
        const txId = `tx-${Date.now()}`;
        return {
          transactionId: txId,
          status: "pending_payment",
          quoteId: req.quoteId,
          createdAt: new Date().toISOString(),
        };
      },
      async getTransaction(transactionId) {
        const stored = data.transactions?.[transactionId] as
          | { sagaState?: string; ledger?: { debited?: boolean; credited?: boolean; txHash?: string } }
          | undefined;
        return {
          transactionId,
          status: "pending",
          createdAt: new Date().toISOString(),
          sagaState: (stored?.sagaState as "INITIATED") ?? "INITIATED",
          ledger: stored?.ledger,
        };
      },
      async listTransactions(userId, opts) {
        void userId;
        return {
          items: [],
          pagination: { cursor: null, hasNext: false, limit: opts.limit },
        };
      },
    },
    partnerRegistry: {
      async registerWebhook(partnerId, req) {
        return {
          webhookId: `wh-${Date.now()}`,
          url: req.url,
          events: req.events,
          createdAt: new Date().toISOString(),
        };
      },
      async verifyApiKey(apiKey) {
        return data.apiKeys?.[apiKey] ?? null;
      },
    },
  };
}