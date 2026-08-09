export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "downstream_unavailable"
  | "downstream_circuit_open"
  | "downstream_timeout"
  | "internal_error"
  | "deprecated_version";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: { field: string; message: string }[];
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { status?: number; details?: { field: string; message: string }[]; headers?: Record<string, string>; cause?: unknown },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = opts?.status ?? defaultStatus(code);
    this.details = opts?.details;
    this.headers = opts?.headers;
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  toProblem(traceId?: string) {
    return {
      type: `https://api.example.com/errors/${this.code}`,
      title: this.code,
      status: this.status,
      code: this.code,
      detail: this.message,
      traceId,
      errors: this.details,
    };
  }
}

export function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "deprecated_version":
      return 410;
    case "downstream_timeout":
      return 504;
    case "downstream_circuit_open":
    case "downstream_unavailable":
      return 503;
    default:
      return 500;
  }
}