import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canSkipTrustedSchoolPhotoReview } from "../../supabase/functions/fam-listing-image-worker/photo-review-policy.js";

const worker = readFileSync(
  new URL("../../supabase/functions/fam-listing-image-worker/index.ts", import.meta.url),
  "utf8",
);

test("trusted school admin can skip image AI review for own school's queued media", () => {
  assert.equal(canSkipTrustedSchoolPhotoReview(
    { role: "school_admin", school_id: "school-1" },
    { user_id: "user-1", school_id: "school-1" },
  ), true);
});

test("trusted council member can skip image AI review for own school's queued media", () => {
  assert.equal(canSkipTrustedSchoolPhotoReview(
    { role: "council_member", school_id: "school-1" },
    { user_id: "user-1", school_id: "school-1" },
  ), true);
});

test("students and unknown roles never receive the exemption", () => {
  for (const role of ["student", "moderator", ""]) {
    assert.equal(canSkipTrustedSchoolPhotoReview(
      { role, school_id: "school-1" },
      { user_id: "user-1", school_id: "school-1" },
    ), false);
  }
});

test("missing or mismatched school assignments fail closed", () => {
  assert.equal(canSkipTrustedSchoolPhotoReview(
    { role: "school_admin", school_id: "school-1" },
    { user_id: "user-1", school_id: "school-2" },
  ), false);
  assert.equal(canSkipTrustedSchoolPhotoReview(
    { role: "council_member", school_id: "" },
    { user_id: "user-1", school_id: "school-1" },
  ), false);
  assert.equal(canSkipTrustedSchoolPhotoReview(
    { role: "school_admin", school_id: "school-1" },
    { user_id: "user-1", school_id: null },
  ), false);
  assert.equal(canSkipTrustedSchoolPhotoReview(null, null), false);
});

test("worker reloads current profile server-side before deciding whether to skip", () => {
  assert.ok(worker.includes("profiles?select=role,school_id&id=eq."));
  assert.ok(worker.includes("canSkipTrustedSchoolPhotoReview(profile, task)"));
  assert.ok(worker.includes("fam_trusted_photo_role_lookup_failed"));
  assert.ok(worker.includes('const moderation = trustedRoleBypass\n      ? await callModeration(task, null)'));
});

test("both avatar and listing queue processors have a narrow trusted-role branch", () => {
  assert.ok(worker.includes("trustedRoleBypass\n      ? { action: \"ok\" }\n      : await callAvatarModeration(task, signedUrl)"));
  assert.ok(worker.includes("trusted_school_role_avatar_image_review_skipped"));
  assert.ok(worker.includes("trusted_school_role_listing_image_review_skipped"));
  assert.ok(worker.includes("!trustedRoleBypass && moderation.action === \"pending\""));
});
