import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../supabase/migrations/20261118212000_restore_own_profile_identity_field_grants.sql", import.meta.url),
  "utf8"
);

test("new profile fields have RLS-protected grants without access to admin-controlled columns", () => {
  assert.match(migration, /c\.relrowsecurity/);
  assert.match(migration, /grant select \(person_type, staff_position, staff_verification_status\)[\s\S]+to authenticated;/i);
  assert.match(migration, /grant update \(person_type, staff_position\)[\s\S]+to authenticated;/i);
  assert.doesNotMatch(migration, /grant (?:select|update) on (?:table )?public\.profiles/i);
  assert.doesNotMatch(migration, /grant update[^;]*(?:role|school_id|staff_verification_status)/i);
});

test("failed signed-in profile requests never masquerade as a wiped profile", () => {
  assert.match(html, /if \(!profile\) \{[\s\S]*?Профиль временно недоступен/);
  assert.match(html, /reportFamSiteError\("database_request_failed", "database"\)/);
  assert.match(html, /sb\.auth\.signOut\(\{ scope: "local" \}\)/);
  assert.doesNotMatch(html, /sb\.auth\.signOut\(\)/);
});
