import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constantTimeSecretMatches } from "../../supabase/functions/moderate/internal-key.mjs";

const moderator = readFileSync(
  new URL("../../supabase/functions/moderate/index.ts", import.meta.url),
  "utf8",
);

test("internal moderator key comparison accepts only an exact non-empty match", async () => {
  assert.equal(await constantTimeSecretMatches("secret-key", "secret-key"), true);
  assert.equal(await constantTimeSecretMatches("secret-keY", "secret-key"), false);
  assert.equal(await constantTimeSecretMatches("secret", "secret-key"), false);
  assert.equal(await constantTimeSecretMatches("secret-key-extra", "secret-key"), false);
  assert.equal(await constantTimeSecretMatches("", "secret-key"), false);
  assert.equal(await constantTimeSecretMatches("secret-key", ""), false);
});

test("moderator protects the internal endpoint with the constant-time comparator", () => {
  assert.match(moderator, /constantTimeSecretMatches\(internalKey, SUPABASE_INTERNAL_KEY\)/);
  assert.doesNotMatch(moderator, /internalKey\s*!==\s*SUPABASE_INTERNAL_KEY/);
});
