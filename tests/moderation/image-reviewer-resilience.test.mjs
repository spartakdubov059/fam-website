import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const moderator = readFileSync(new URL("../../supabase/functions/moderate/index.ts", import.meta.url), "utf8");
const reviewer = readFileSync(new URL("../../supabase/functions/moderate/image-reviewer.ts", import.meta.url), "utf8");

test("photo submissions use one free multimodal moderation request, not a paid image model", () => {
  assert.match(moderator, /https:\/\/api\.openai\.com\/v1\/moderations/);
  assert.match(moderator, /\{ type: "image_url", image_url: \{ url: imageUrl \} \}/);
  assert.doesNotMatch(moderator, /reviewListingImage/);
  assert.match(moderator, /provider: "openai_moderation"/);
  assert.match(moderator, /fam-openai-moderation-v3/);
  assert.match(reviewer, /https:\/\/api\.openai\.com\/v1\/moderations/);
  assert.doesNotMatch(reviewer, /gpt-5-mini|v1\/chat\/completions/);
});

test("flagged image categories stay hidden for human review", () => {
  assert.match(moderator, /flaggedByInput\.image\.length > 0 \|\| flaggedByInput\.unresolved\.length > 0/);
  assert.match(moderator, /requiresImageHumanReview\\s*\\?\\s*"image_requires_human_review"/);
  assert.match(moderator, /Материал скрыт и требует проверки/);
});
