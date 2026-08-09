export type OrchestratorSagaState =
  | "INITIATED"
  | "QUOTE_LOCKED"
  | "PAYMENT_PENDING"
  | "PAYMENT_RECEIVED"
  | "KYC_PENDING"
  | "KYC_PASSED"
  | "EXECUTING"
  | "SETTLED"
  | "PAYMENT_FAILED"
  | "KYC_FAILED"
  | "EXECUTION_FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type ClientTransactionStatus =
  | "pending"
  | "pending_payment"
  | "pending_kyc"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

const SAGA_TO_CLIENT: Record<OrchestratorSagaState, ClientTransactionStatus> = {
  INITIATED: "pending",
  QUOTE_LOCKED: "pending",
  PAYMENT_PENDING: "pending_payment",
  PAYMENT_RECEIVED: "pending_payment",
  KYC_PENDING: "pending_kyc",
  KYC_PASSED: "processing",
  EXECUTING: "processing",
  SETTLED: "completed",
  PAYMENT_FAILED: "failed",
  KYC_FAILED: "failed",
  EXECUTION_FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};

export function mapSagaStateToClient(saga: OrchestratorSagaState): ClientTransactionStatus {
  return SAGA_TO_CLIENT[saga] ?? "pending";
}

export function sagaFailureReason(saga: OrchestratorSagaState): string | undefined {
  switch (saga) {
    case "PAYMENT_FAILED":
      return "payment_failed";
    case "KYC_FAILED":
      return "kyc_failed";
    case "EXECUTION_FAILED":
      return "execution_failed";
    default:
      return undefined;
  }
}