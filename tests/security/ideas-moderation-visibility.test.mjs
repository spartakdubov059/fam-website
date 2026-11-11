import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261111163500_restrict_unapproved_ideas_from_council.sql", import.meta.url),
  "utf8",
);

test("unapproved ideas are hidden from student Council at the database policy layer", () => {
  assert.match(migration, /p\.role\s*=\s*'council_member'[\s\S]*?ideas\.ai_status\s*=\s*'approved'/);
  assert.match(migration, /p\.role\s*=\s*'school_admin'/);
  assert.match(migration, /user_id\s*=\s*\(select auth\.uid\(\)\)/);
  assert.match(migration, /drop policy if exists "Same-school council updates ideas"/);
});
