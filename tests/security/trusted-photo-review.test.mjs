import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canSkipListingImageReview } from "../../supabase/functions/submit-content/photo-review-policy.js";

const submitContent = readFileSync(
  new URL("../../supabase/functions/submit-content/index.ts", import.meta.url),
  "utf8",
);

test("only a database-verified school admin can skip AI image review", () => {
  assert.equal(canSkipListingImageReview({
    role: "school_admin",
    school_id: "school-1",
  }, "https://private.example/photo"), true);
});

test("only a database-verified council member can skip AI image review", () => {
  assert.equal(canSkipListingImageReview({
    role: "council_member",
    school_id: "school-1",
  }, "https://private.example/photo"), true);
});

test("ordinary students and unknown roles still require image review", () => {
  assert.equal(canSkipListingImageReview({
    role: "student",
    school_id: "school-1",
  }, "https://private.example/photo"), false);
  assert.equal(canSkipListingImageReview({
    role: "moderator",
    school_id: "school-1",
  }, "https://private.example/photo"), false);
});

test("trusted role without a school or an uploaded image does not receive an exemption", () => {
  assert.equal(canSkipListingImageReview({
    role: "school_admin",
    school_id: null,
  }, "https://private.example/photo"), false);
  assert.equal(canSkipListingImageReview({
    role: "council_member",
    school_id: "school-1",
  }, null), false);
  assert.equal(canSkipListingImageReview(null, "https://private.example/photo"), false);
});

test("the Edge Function bases the exemption on a server-loaded profile, not client role data", () => {
  assert.ok(submitContent.includes('profiles?select=id,school_id,role,avatar_url&id='));
  assert.ok(submitContent.includes("canSkipListingImageReview(profile, imageUrl)"));
  assert.ok(!submitContent.includes("payload.role"));
});

test("trusted uploads skip only image AI review; text moderation remains mandatory", () => {
  assert.ok(submitContent.includes("bypassPhotoAiReview ? null : imageUrl"));
  assert.ok(submitContent.includes("title + \"\\n\" + description + \"\\n\" + priceText"));
  assert.ok(submitContent.includes("if (!moderation) return fail("));
  assert.ok(submitContent.includes('if (moderation.action === "reject")'));
  assert.ok(submitContent.includes("&& !bypassPhotoAiReview"));
  assert.ok(submitContent.includes("photo_review_bypassed: bypassPhotoAiReview"));
});
