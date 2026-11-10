
export function isRetryableModerationFailure(result = {}) {
  const code = typeof result.reason_code === "string" ? result.reason_code : "";
  const diagnostic = typeof result.diagnostic_code === "string" ? result.diagnostic_code : "";
  if ([
    "image_review_rate_limited",
    "image_review_quota_exceeded",
    "image_review_unavailable",
    "image_review_no_decision",
    "openai_rate_limited",
    "openai_unavailable",
    "openai_invalid_response",
    "moderation_internal_error",
  ].includes(code) || [
    "openai_rate_limited",
    "openai_unavailable",
    "openai_invalid_response",
    "moderation_internal_error",
    "missing_api_key",
  ].includes(diagnostic)) return true;
  return result.degraded === true && ![
    "image_requires_human_review",
    "sensitive_category_requires_separate_process",
    "personal_contact_data",
  ].includes(code);
}

export function retryDelaySeconds(attempt) {
  const delays = [60, 180, 600, 1800, 3600];
  const index = Math.max(0, Math.min(delays.length - 1, Number(attempt) - 1 || 0));
  return delays[index];
}

export const MAX_IMAGE_MODERATION_ATTEMPTS = 10;
