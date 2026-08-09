import type {
  AppConfig,
} from "../config.js";
import type {
  IdentityAuthClient,
  KycClient,
  PricingClient,
  OrchestratorClient,
  PartnerRegistryClient,
  DownstreamClients,
} from "./types.js";
import type {
  AuthSessionRequest,
  AuthSessionResponse,
  UserProfile,
  KycStatusResponse,
  KycStartRequest,
  KycStartResponse,
  QuoteRequest,
  QuoteResponse,
  InitiateTransactionRequest,
  TransactionResponse,
  TransactionDetailResponse,
  TransactionListResponse,
  PartnerWebhookRegistration,
  PartnerWebhookRegistrationResponse,
} from "../domain/schemas.js";
import type { OrchestratorSagaState } from "../domain/status-mapping.js";
import { mapSagaStateToClient, sagaFailureReason } from "../domain/status-mapping.js";
import { DownstreamClient, type ServiceTokenProvider, type TraceContextProvider, type CacheStore } from "./downstream.js";

export interface ClientFactoryDeps {
  config: AppConfig;
  tokenProvider?: ServiceTokenProvider;
  traceProvider?: TraceContextProvider;
  cache?: CacheStore;
}

class IdentityAuthAdapter implements IdentityAuthClient {
  private dc: DownstreamClient;
  constructor(deps: ClientFactoryDeps) {
    this.dc = new DownstreamClient({
      service: "identity-auth",
      baseUrl: deps.config.IDENTITY_AUTH_URL,
      config: deps.config,
      tokenProvider: deps.tokenProvider,
      traceProvider: deps.traceProvider,
      cache: deps.cache,
      maxRetries: 1,
      cacheTtlMs: 30_000,
      bulkhead: 1,
    });
  }
  async exchangeSession(req: AuthSessionRequest): Promise<AuthSessionResponse> {
    const r = await this.dc.request<AuthSessionResponse>({
      method: "POST",
      path: "/v1/sessions",
      body: req,
      idempotent: false,
    });
    return r.body;
  }
  async getProfile(userId: string): Promise<UserProfile> {
    const r = await this.dc.request<UserProfile>({
      method: "GET",
      path: `/v1/users/${encodeURIComponent(userId)}`,
      idempotent: true,
      cacheKey: `profile:${userId}`,
    } as never);
    return r.body;
  }
  state() {
    return this.dc.circuitState;
  }
}

class KycAdapter implements KycClient {
  private dc: DownstreamClient;
  constructor(deps: ClientFactoryDeps) {
    this.dc = new DownstreamClient({
      service: "onboarding-kyc",
      baseUrl: deps.config.KYC_URL,
      config: deps.config,
      tokenProvider: deps.tokenProvider,
      traceProvider: deps.traceProvider,
      cache: deps.cache,
      cacheTtlMs: 15_000,
    });
  }
  async getStatus(userId: string): Promise<KycStatusResponse> {
    const r = await this.dc.request<KycStatusResponse>({
      method: "GET",
      path: `/v1/kyc/${encodeURIComponent(userId)}`,
      idempotent: true,
      cacheKey: `kyc:${userId}`,
    } as never);
    return r.body;
  }
  async start(userId: string, req: KycStartRequest): Promise<KycStartResponse> {
    const r = await this.dc.request<KycStartResponse>({
      method: "POST",
      path: "/v1/kyc/start",
      body: { userId, ...req },
      idempotent: false,
    });
    return r.body;
  }
  state() {
    return this.dc.circuitState;
  }
}

class PricingAdapter implements PricingClient {
  private dc: DownstreamClient;
  constructor(deps: ClientFactoryDeps) {
    this.dc = new DownstreamClient({
      service: "pricing-quote",
      baseUrl: deps.config.PRICING_URL,
      config: deps.config,
      tokenProvider: deps.tokenProvider,
      traceProvider: deps.traceProvider,
    });
  }
  async createQuote(req: QuoteRequest): Promise<QuoteResponse> {
    const r = await this.dc.request<QuoteResponse>({
      method: "POST",
      path: "/v1/quotes",
      body: req,
      idempotent: false,
    });
    return r.body;
  }
  state() {
    return this.dc.circuitState;
  }
}

class OrchestratorAdapter implements OrchestratorClient {
  private dc: DownstreamClient;
  constructor(deps: ClientFactoryDeps) {
    this.dc = new DownstreamClient({
      service: "transaction-orchestrator",
      baseUrl: deps.config.ORCHESTRATOR_URL,
      config: deps.config,
      tokenProvider: deps.tokenProvider,
      traceProvider: deps.traceProvider,
      cacheTtlMs: 5_000,
    });
  }
  async initiate(
    req: InitiateTransactionRequest & { idempotencyKey: string; userId: string },
  ): Promise<TransactionResponse> {
    const r = await this.dc.request<TransactionResponse>({
      method: "POST",
      path: "/v1/transactions",
      body: req,
      idempotent: true,
      headers: { "idempotency-key": req.idempotencyKey },
    });
    return r.body;
  }
  async getTransaction(
    transactionId: string,
  ): Promise<TransactionDetailResponse & { sagaState: OrchestratorSagaState }> {
    const r = await this.dc.request<{ sagaState: OrchestratorSagaState; transactionId: string; createdAt: string; ledger?: { debited?: boolean; credited?: boolean; txHash?: string } }>({
      method: "GET",
      path: `/v1/transactions/${encodeURIComponent(transactionId)}`,
      idempotent: true,
      cacheKey: `tx:${transactionId}`,
    } as never);
    const b = r.body;
    return {
      transactionId: b.transactionId,
      status: mapSagaStateToClient(b.sagaState),
      createdAt: b.createdAt,
      updatedAt: new Date().toISOString(),
      failureReason: sagaFailureReason(b.sagaState),
      ledger: b.ledger,
      sagaState: b.sagaState,
    };
  }
  async listTransactions(
    userId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<TransactionListResponse> {
    const qs = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const r = await this.dc.request<TransactionListResponse>({
      method: "GET",
      path: `/v1/transactions?${qs.toString()}`,
      idempotent: true,
      headers: { "x-user-id": userId },
    });
    return r.body;
  }
  state() {
    return this.dc.circuitState;
  }
}

class PartnerRegistryAdapter implements PartnerRegistryClient {
  private dc: DownstreamClient;
  constructor(deps: ClientFactoryDeps) {
    this.dc = new DownstreamClient({
      service: "identity-auth-partner",
      baseUrl: deps.config.IDENTITY_AUTH_URL,
      config: deps.config,
      tokenProvider: deps.tokenProvider,
      traceProvider: deps.traceProvider,
    });
  }
  async registerWebhook(
    partnerId: string,
    req: PartnerWebhookRegistration,
  ): Promise<PartnerWebhookRegistrationResponse> {
    const r = await this.dc.request<PartnerWebhookRegistrationResponse>({
      method: "POST",
      path: "/v1/partner/webhooks",
      body: { partnerId, ...req },
      idempotent: true,
      headers: { "x-partner-id": partnerId },
    });
    return r.body;
  }
  async verifyApiKey(apiKey: string): Promise<{ partnerId: string; identity: string } | null> {
    try {
      const r = await this.dc.request<{ partnerId: string; identity: string }>({
        method: "POST",
        path: "/v1/partner/api-keys/verify",
        body: { apiKey },
        idempotent: true,
      });
      return r.body;
    } catch {
      return null;
    }
  }
  state() {
    return this.dc.circuitState;
  }
}

export interface HttpClientFactory extends DownstreamClients {
  downstream: {
    identityAuth: DownstreamClient;
    kyc: DownstreamClient;
    pricing: DownstreamClient;
    orchestrator: DownstreamClient;
    partnerRegistry: DownstreamClient;
  };
  states(): { service: string; state: string }[];
}

export function createHttpClients(deps: ClientFactoryDeps): HttpClientFactory {
  const identityAuth = new IdentityAuthAdapter(deps);
  const kyc = new KycAdapter(deps);
  const pricing = new PricingAdapter(deps);
  const orchestrator = new OrchestratorAdapter(deps);
  const partnerRegistry = new PartnerRegistryAdapter(deps);
  return {
    identityAuth,
    kyc,
    pricing,
    orchestrator,
    partnerRegistry,
    downstream: {
      get identityAuth() {
        return (identityAuth as unknown as { dc: DownstreamClient }).dc;
      },
      get kyc() {
        return (kyc as unknown as { dc: DownstreamClient }).dc;
      },
      get pricing() {
        return (pricing as unknown as { dc: DownstreamClient }).dc;
      },
      get orchestrator() {
        return (orchestrator as unknown as { dc: DownstreamClient }).dc;
      },
      get partnerRegistry() {
        return (partnerRegistry as unknown as { dc: DownstreamClient }).dc;
      },
    },
    states() {
      return [
        { service: "identity-auth", state: identityAuth.state() },
        { service: "onboarding-kyc", state: kyc.state() },
        { service: "pricing-quote", state: pricing.state() },
        { service: "transaction-orchestrator", state: orchestrator.state() },
        { service: "identity-auth-partner", state: partnerRegistry.state() },
      ];
    },
  };
}