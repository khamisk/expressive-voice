export type RealtimeStartupError = {
  error: string;
  code: "insufficient_quota" | "credit_balance_exhausted" | "organization_spend_limit_exceeded"
    | "project_spend_limit_exceeded" | "organization_usage_limit_exceeded"
    | "invalid_api_key" | "rate_limited" | "model_unavailable"
    | "access_denied" | "session_configuration" | "service_unavailable" | "session_failed";
  retryable: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Classify provider failures without returning raw messages, IDs, or credentials. */
export function describeRealtimeStartupError(status: number, body: string): RealtimeStartupError {
  let fields: Record<string, unknown> | undefined;
  let plainMessage = "";
  try {
    const parsed = record(JSON.parse(body));
    fields = record(parsed?.error) ?? parsed;
    if (typeof parsed?.error === "string") plainMessage = parsed.error;
  } catch {
    // Some gateways return plain text or HTML. Only known failure phrases
    // below affect classification; the actual response is never exposed.
    plainMessage = body.slice(0, 8_192);
  }
  const code = typeof fields?.code === "string" ? fields.code.toLowerCase() : "";
  const type = typeof fields?.type === "string" ? fields.type.toLowerCase() : "";
  const message = (typeof fields?.message === "string" ? fields.message : plainMessage).slice(0, 8_192).toLowerCase();
  // The provider can use insufficient_quota as a broad type for several
  // different billing failures. The specific code owns the recovery action.
  if (code === "credit_balance_exhausted") {
    return { code, retryable: false, error: "OpenAI API credits have run out. Add credits in API billing, then start again." };
  }
  if (code === "project_spend_limit_exceeded") {
    return { code, retryable: false, error: "The OpenAI project's spending limit has been reached. Check the limit in API project settings." };
  }
  if (code === "organization_spend_limit_exceeded") {
    return { code, retryable: false, error: "The OpenAI organization's spending limit has been reached. Check the limit in API settings." };
  }
  if (code === "organization_usage_limit_exceeded") {
    return { code, retryable: false, error: "The OpenAI organization's usage limit has been reached. Check your approved API usage limit." };
  }
  const quota = [code, type].some(value => /^(?:insufficient_quota|billing_hard_limit_reached|billing_not_active|usage_limit_reached)$/u.test(value));
  const emptyCredits = /(?:no credits remaining|(?:insufficient|not enough) credits|(?:credit balance|credits) (?:is |are |has |have )?(?:exhausted|depleted|run out))/u.test(message);
  if (quota || emptyCredits || status === 402) {
    return {
      code: "insufficient_quota", retryable: false,
      error: emptyCredits
        ? "OpenAI API credits have run out. Add credits in API billing, then start again."
        : "OpenAI API credits or usage limits need attention. Check API billing and project limits, then start again.",
    };
  }
  if (status === 401 || code === "invalid_api_key") {
    return { code: "invalid_api_key", retryable: false, error: "The OpenAI API key was rejected. Replace it with a valid project key." };
  }
  if (code === "model_not_found" || code === "model_not_available" || status === 404) {
    return { code: "model_unavailable", retryable: false, error: "This OpenAI voice model is unavailable to the project. Check its model access and configuration." };
  }
  if (status === 403) {
    return { code: "access_denied", retryable: false, error: "The OpenAI project cannot access voice sessions. Check the API key permissions and project access." };
  }
  if (status === 429) {
    return {
      code: "rate_limited", retryable: true,
      error: code === "rate_limit_exceeded" || type === "rate_limit_exceeded"
        ? "OpenAI is rate limiting voice requests. Wait a moment, then start again."
        : "OpenAI is limiting voice requests. Check API usage and billing, then retry later.",
    };
  }
  if (status === 400 || status === 422) {
    return { code: "session_configuration", retryable: false, error: "OpenAI rejected the voice session configuration. Check the model and session settings." };
  }
  if (status >= 500 || status === 408) {
    return { code: "service_unavailable", retryable: true, error: "The OpenAI voice service is temporarily unavailable. Please try again shortly." };
  }
  return { code: "session_failed", retryable: false, error: "The voice session could not start. Check the local server diagnostics for the failure code." };
}
