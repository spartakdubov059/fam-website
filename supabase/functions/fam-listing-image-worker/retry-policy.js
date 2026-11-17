const RETRYABLE_CODES = new Set([
  "image_review_rate_limited",
  "image_review_quota_exceeded",
  "image_review_unavailable",
  "image_review_no_decision",
  "openai_rate_limited",
  "openai_unavailable",
  "openai_invalid_response",
  "moderation_internal_error",
]);

const NON_RETRYABLE_CODES = new Set([
  "image_review_key_rejected",
  "image_review_bad_request",
  "openai_key_rejected",
  "openai_bad_request",
  "missing_api_key",
  "image_requires_human_review",
  "sensitive_category_requires_separate_process",
  "personal_contact_data",
]);

export function isRetryableModerationFailure(result = {}) {
  const code = typeof result.reason_code === "string" ? result.reason_code : "";
  const diagnostic = typeof result.diagnostic_code === "string" ? result.diagnostic_code : "";
  if (NON_RETRYABLE_CODES.has(code) || NON_RETRYABLE_CODES.has(diagnostic)) return false;
  return RETRYABLE_CODES.has(code) || RETRYABLE_CODES.has(diagnostic);
}

export function retryDelaySeconds(attempt) {
  const delays = [60, 180, 600, 1800, 3600, 21600];
  const index = Math.max(0, Math.min(delays.length - 1, Number(attempt) - 1 || 0));
  return delays[index];
}

// Retryable service failures are retried indefinitely with a six-hour ceiling.
