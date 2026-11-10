import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  boundedRetryDelayMs,
  shouldRetryImageReviewRateLimit,
} from "../../supabase/functions/moderate/image-reviewer-utils.js";

const reviewer = readFileSync(
  new URL("../../supabase/functions/moderate/image-reviewer.ts", import.meta.url),
  "utf8",
);
const moderator = readFileSync(
  new URL("../../supabase/functions/moderate/index.ts", import.meta.url),
  "utf8",
);

test("retries one transient image-review rate limit but not exhausted provider quota", () => {
  assert.equal(shouldRetryImageReviewRateLimit(429, "rate_limit_exceeded", 0), true);
  assert.equal(shouldRetryImageReviewRateLimit(429, null, 0), true);
  assert.equal(shouldRetryImageReviewRateLimit(429, "insufficient_quota", 0), false);
  assert.equal(shouldRetryImageReviewRateLimit(429, "billing_hard_limit_reached", 0), false);
  assert.equal(shouldRetryImageReviewRateLimit(429, "rate_limit_exceeded", 1), false);
  assert.equal(shouldRetryImageReviewRateLimit(500, "rate_limit_exceeded", 0), false);
});

test("Retry-After is honored within a short bounded window", () => {
  assert.equal(boundedRetryDelayMs(null), 800);
  assert.equal(boundedRetryDelayMs("1"), 1000);
  assert.equal(boundedRetryDelayMs("0"), 250);
  assert.equal(boundedRetryDelayMs("60"), 5000);
  assert.equal(boundedRetryDelayMs("not-a-date"), 800);
  assert.equal(boundedRetryDelayMs("2026-11-10T17:00:02.000Z", Date.parse("2026-11-10T17:00:00.000Z")), 2000);
});

test("photo-review rate limits are reported as a provider problem, not a prohibited photo", () => {
  assert.match(reviewer, /Фото не признано запрещённым/);
  assert.match(reviewer, /image_review_quota_exceeded/);
  assert.match(reviewer, /shouldRetryImageReviewRateLimit/);
  assert.match(moderator, /image_review_rate_limited: \{ category: "unclear_safety_signal"/);
  assert.match(moderator, /image_review_quota_exceeded: \{ category: "unclear_safety_signal"/);
  assert.match(moderator, /Provider rate limits, quota, or outages are service failures, not user safety violations/);
});

test("real personal-data findings and unsafe image findings still create safety signals", () => {
  assert.match(moderator, /personal_information", "private_document/);
  assert.match(moderator, /imageReview\.action === "reject"/);
  assert.match(moderator, /writeSafetySignal\(safetyContext, "unsafe_image", "high"\)/);
  assert.match(moderator, /image_requires_review/,);
});
