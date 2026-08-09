import type {
  AuthSessionRequest,
  AuthSessionResponse,
  UserProfile,
  KycStatusResponse,
  QuoteRequest,
  QuoteResponse,
  InitiateTransactionRequest,
  TransactionResponse,
  TransactionDetailResponse,
  TransactionListResponse,
  KycStartRequest,
  KycStartResponse,
  PartnerWebhookRegistration,
  PartnerWebhookRegistrationResponse,
} from "../domain/schemas.js";
import type { OrchestratorSagaState } from "../domain/status-mapping.js";

export interface IdentityAuthClient {
  exchangeSession(req: AuthSessionRequest): Promise<AuthSessionResponse>;
  getProfile(userId: string): Promise<UserProfile>;
}

export interface KycClient {
  getStatus(userId: string): Promise<KycStatusResponse>;
  start(userId: string, req: KycStartRequest): Promise<KycStartResponse>;
}

export interface PricingClient {
  createQuote(req: QuoteRequest): Promise<QuoteResponse>;
}

export interface OrchestratorClient {
  initiate(req: InitiateTransactionRequest & { idempotencyKey: string; userId: string }): Promise<TransactionResponse>;
  getTransaction(transactionId: string): Promise<TransactionDetailResponse & { sagaState: OrchestratorSagaState }>;
  listTransactions(userId: string, opts: { limit: number; cursor?: string | null }): Promise<TransactionListResponse>;
}

export interface PartnerRegistryClient {
  registerWebhook(partnerId: string, req: PartnerWebhookRegistration): Promise<PartnerWebhookRegistrationResponse>;
  verifyApiKey(apiKey: string): Promise<{ partnerId: string; identity: string } | null>;
}

export interface DownstreamClients {
  identityAuth: IdentityAuthClient;
  kyc: KycClient;
  pricing: PricingClient;
  orchestrator: OrchestratorClient;
  partnerRegistry: PartnerRegistryClient;
}