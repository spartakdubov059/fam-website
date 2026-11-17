import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitFlaggedCategoriesByInputType } from "../../supabase/functions/moderate/moderation-input-types.js";

const moderator = readFileSync(
  new URL("../../supabase/functions/moderate/index.ts", import.meta.url),
  "utf8",
);

test("a text-only harassment flag is not attributed to the attached photo", () => {
  const split = splitFlaggedCategoriesByInputType(
    ["harassment"],
    { harassment: ["text"] },
  );
  assert.deepEqual(split, {
    text: ["harassment"],
    image: [],
    unresolved: [],
  });
});

test("image-supported flags are separated from text-only flags", () => {
  const split = splitFlaggedCategoriesByInputType(
    ["harassment", "violence"],
    { harassment: ["text"], violence: ["text", "image"] },
  );
  assert.deepEqual(split, {
    text: ["harassment", "violence"],
    image: ["violence"],
    unresolved: [],
  });
});

test("missing type information for unknown categories stays fail-closed", () => {
  const split = splitFlaggedCategoriesByInputType(
    ["harassment", "unknown_category"],
    {},
  );
  assert.deepEqual(split, {
    text: ["harassment"],
    image: [],
    unresolved: ["unknown_category"],
  });
});

test("cleared text still goes through a separate image review", () => {
  assert.match(moderator, /category_applied_input_types/);
  assert.match(moderator, /requiresImageHumanReview/);
  assert.match(moderator, /text_only_flags: flaggedByInput\.text/);
  assert.match(moderator, /if \(!imageUrl\)[\s\S]*?return cacheAndRespond[\s\S]*?if \(imageUrl\)/);
  assert.match(moderator, /categories_applied_to_image/);
});
