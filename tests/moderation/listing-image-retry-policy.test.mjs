import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableModerationFailure,
  retryDelaySeconds,
} from "../../supabase/functions/fam-listing-image-worker/retry-policy.js";

test("transient rate limits and provider outages are retried", () => {
  for (const reason_code of [
    "image_review_rate_limited",
    "image_review_quota_exceeded",
    "image_review_unavailable",
    "image_review_no_decision",
    "openai_rate_limited",
    "openai_unavailable",
    "openai_invalid_response",
    "moderation_internal_error",
  ]) {
    assert.equal(isRetryableModerationFailure({ action: "pending", reason_code }), true, reason_code);
  }
});

test("credentials, malformed requests, and safety decisions are not retried", () => {
  for (const reason_code of [
    "image_review_key_rejected",
    "image_review_bad_request",
    "image_requires_human_review",
    "sensitive_category_requires_separate_process",
    "personal_contact_data",
  ]) {
    assert.equal(isRetryableModerationFailure({ action: "pending", reason_code }), false, reason_code);
  }
  assert.equal(isRetryableModerationFailure({ action: "pending", diagnostic_code: "openai_key_rejected" }), false);
  assert.equal(isRetryableModerationFailure({ action: "pending", diagnostic_code: "openai_bad_request" }), false);
  assert.equal(isRetryableModerationFailure({ action: "pending", diagnostic_code: "missing_api_key" }), false);
  assert.equal(isRetryableModerationFailure({ action: "reject", reason_code: "unsafe_content" }), false);
});

test("retry policy is intentionally allowlisted rather than retrying every degraded response", () => {
  assert.equal(isRetryableModerationFailure({ action: "pending", degraded: true, diagnostic_code: "openai_rate_limited" }), true);
  assert.equal(isRetryableModerationFailure({ action: "pending", degraded: true, diagnostic_code: "openai_key_rejected" }), false);
  assert.equal(isRetryableModerationFailure({ action: "pending", degraded: true, diagnostic_code: "unknown_error" }), false);
  assert.equal(isRetryableModerationFailure({ action: "pending", reason_code: "image_review_quota_exceeded" }), true);
});

test("retry schedule backs off and continues at a six-hour ceiling until the provider recovers", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds), [60, 180, 600, 1800, 3600, 21600, 21600]);
});
