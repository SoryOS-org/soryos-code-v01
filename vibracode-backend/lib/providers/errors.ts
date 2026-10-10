/**
 * Provider-agnostic error type. Adapters translate HTTP/transport failures into
 * a `ProviderError` so the agent loop and the UI can react consistently and
 * surface the *real* error instead of a generic "something went wrong".
 */

export type ProviderErrorCode =
  | "missing_api_key"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "model_unavailable"
  | "model_not_found"
  | "tool_calling_unsupported"
  | "bad_request"
  | "network"
  | "timeout"
  | "aborted"
  | "provider_error";

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  provider: string;
  message: string;
  status?: number;
  retryable?: boolean;
  details?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "ProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableCode(options.code);
    this.details = options.details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      provider: this.provider,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export function isRetryableCode(code: ProviderErrorCode): boolean {
  return code === "rate_limited" || code === "network" || code === "timeout" || code === "provider_error";
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** Map an HTTP status to a provider error code. */
export function codeForStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "model_not_found";
    case 400:
    case 422:
      return "bad_request";
    case 402:
      return "rate_limited";
    case 429:
      return "rate_limited";
    case 408:
    case 504:
      return "timeout";
    default:
      return status >= 500 ? "provider_error" : "provider_error";
  }
}

/** Detect tool-calling support errors so we can tell the user honestly. */
export function looksLikeToolUnsupported(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (t.includes("tool") &&
      (t.includes("not support") ||
        t.includes("unsupported") ||
        t.includes("does not support") ||
        t.includes("no endpoints found") ||
        t.includes("doesn't support"))) ||
    t.includes("function calling is not supported") ||
    t.includes("tool_choice")
  );
}
