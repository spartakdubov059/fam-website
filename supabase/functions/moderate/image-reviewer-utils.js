/**
 * Bounded retry policy for external image-review provider responses.
 * Keep this helper side-effect free so its decisions are covered by Node tests.
 */
export function shouldRetryImageReviewRateLimit(
  status,
  providerErrorCode,
  attemptIndex,
) {
  if (status !== 429 || attemptIndex !== 0) return false;
  return providerErrorCode !== "insufficient_quota"
    && providerErrorCode !== "billing_hard_limit_reached";
}

/**
 * Interpret Retry-After seconds or HTTP date, with conservative lower and upper bounds.
 */
export function boundedRetryDelayMs(retryAfter, now = Date.now()) {
  const fallbackMs = 800;
  if (typeof retryAfter !== "string" || !retryAfter.trim()) return fallbackMs;

  const trimmed = retryAfter.trim();
  const seconds = Number(trimmed);
  let requestedMs;

  if (Number.isFinite(seconds)) {
    requestedMs = seconds * 1000;
  } else {
    const retryAt = Date.parse(trimmed);
    requestedMs = Number.isFinite(retryAt) ? retryAt - now : fallbackMs;
  }

  return Math.min(5000, Math.max(250, Math.ceil(requestedMs)));
}
