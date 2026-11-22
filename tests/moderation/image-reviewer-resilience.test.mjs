import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  boundedRetryDelayMs,
  isExhaustedImageReviewQuota,
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
const retryPolicy = readFileSync(
  new URL("../../supabase/functions/moderate/image-reviewer-utils.js", import.meta.url),
  "utf8",
);

test("retries one transient image-review rate limit but not exhausted provider quota", () => {
  assert.equal(shouldRetryImageReviewRateLimit(429, "rate_limit_exceeded", 0), true);
  assert.equal(shouldRetryImageReviewRateLimit(429, null, 0), true);
  assert.equal(shouldRetryImageReviewRateLimit(429, "insufficient_quota", 0), false);
  assert.equal(shouldRetryImageReviewRateLimit(429, "billing_hard_limit_reached", 0), false);
  assert.equal(shouldRetryImageReviewRateLimit(429, "credit_balance_exhausted", 0), false);
  assert.equal(isExhaustedImageReviewQuota("credit_balance_exhausted"), true);
  assert.equal(isExhaustedImageReviewQuota("rate_limit_exceeded"), false);
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
  assert.match(reviewer, /reason_code: response\?\.status === 429 \? "image_review_rate_limited"/);
  assert.match(reviewer, /Сервис проверки временно недоступен\. Фото пока не опубликовано\./);
  assert.doesNotMatch(reviewer, /Фото признано запрещённым/);
  assert.match(retryPolicy, /shouldRetryImageReviewRateLimit/);
  assert.match(retryPolicy, /isExhaustedImageReviewQuota/);
  const cachedSignalMap = moderator.slice(moderator.indexOf("const map:"), moderator.indexOf("const signal = map[code]"));
  assert.doesNotMatch(cachedSignalMap, /image_review_(?:rate_limited|quota_exceeded|unavailable|no_decision)/);
  assert.match(moderator, /Provider failures describe infrastructure, not user conduct/);
});

test("real personal-data findings and unsafe image findings still create safety signals", () => {
  assert.match(moderator, /personal_information: \{ category: "personal_data_in_image"/);
  assert.match(moderator, /private_document: \{ category: "personal_data_in_image"/);
  assert.match(moderator, /image_requires_human_review: \{ category: "unclear_safety_signal", severity: "high"/);
  assert.match(moderator, /writeSafetySignal\(safetyContext, "unsafe_image", "high"\)/);
  assert.match(reviewer, /reason_code: "image_requires_human_review"/);
});
