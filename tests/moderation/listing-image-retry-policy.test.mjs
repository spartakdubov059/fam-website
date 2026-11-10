
import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableModerationFailure,
  retryDelaySeconds,
  MAX_IMAGE_MODERATION_ATTEMPTS,
} from "../../supabase/functions/fam-listing-image-worker/retry-policy.js";

test("temporary image provider failures are retried", () => {
  for (const reason_code of [
    "image_review_rate_limited",
    "image_review_quota_exceeded",
    "image_review_unavailable",
    "image_review_no_decision",
    "openai_rate_limited",
  ]) {
    assert.equal(isRetryableModerationFailure({ action: "pending", reason_code }), true);
  }
});

test("safety review decisions are not retried as infrastructure errors", () => {
  assert.equal(isRetryableModerationFailure({ action: "pending", reason_code: "image_requires_human_review" }), false);
  assert.equal(isRetryableModerationFailure({ action: "reject", reason_code: "unsafe_content" }), false);
});

test("degraded provider failures are retried but capped", () => {
  assert.equal(isRetryableModerationFailure({ action: "pending", degraded: true, diagnostic_code: "openai_rate_limited" }), true);
  assert.equal(MAX_IMAGE_MODERATION_ATTEMPTS, 10);
});

test("retry schedule backs off and never exceeds one hour", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds), [60, 180, 600, 1800, 3600, 3600, 3600]);
});
