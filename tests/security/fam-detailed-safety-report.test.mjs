import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const frontend = readFileSync(new URL("index.html", root), "utf8");
const council = readFileSync(new URL("supabase/functions/council-management/index.ts", root), "utf8");
const safetyAgent = readFileSync(new URL("supabase/functions/moderate/user-safety-agent.ts", root), "utf8");
const moderator = readFileSync(new URL("supabase/functions/moderate/index.ts", root), "utf8");
const migration = readFileSync(
  new URL("supabase/migrations/20261112060000_enrich_fam_safety_incidents_with_actor_and_evidence.sql", root),
  "utf8",
);

test("deleting your own school-admin listing skips password reauthentication", () => {
  const helperStart = frontend.indexOf("async function callCouncilManagement(");
  const helperEnd = frontend.indexOf("\n  async function manageCouncilRole", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = frontend.slice(helperStart, helperEnd);
  assert.match(helper, /options\.skipReauth\s*!==\s*true/);
  assert.match(helper, /sensitiveActions\.has\(action\)/);
  const sensitiveStart = helper.indexOf("const sensitiveActions = new Set([");
  const sensitiveEnd = helper.indexOf("]);", sensitiveStart);
  assert.ok(sensitiveStart >= 0 && sensitiveEnd > sensitiveStart);
  assert.doesNotMatch(helper.slice(sensitiveStart, sensitiveEnd), /"delete_listing"/);
  assert.match(helper, /action === "delete_listing"/);

  const adminDeleteStart = frontend.indexOf("async function manageSchoolListing(");
  const adminDeleteEnd = frontend.indexOf("\n  async function suspendCouncilAccount", adminDeleteStart);
  assert.ok(adminDeleteStart >= 0 && adminDeleteEnd > adminDeleteStart);
  const adminDelete = frontend.slice(adminDeleteStart, adminDeleteEnd);
  assert.match(adminDelete, /skipReauth:\s*listing\?\.user_id\s*===\s*user\.id/);
  assert.match(adminDelete, /confirm\(/);
});

test("server still verifies role, school ownership and recent sign-in for deleting somebody else's listing", () => {
  assert.match(council, /actor\.role !== "school_admin"/);
  assert.match(council, /ownerSchoolId !== actor\.school_id/);
  assert.match(council, /listing\.user_id !== actorId && !tokenWasIssuedRecently\(authorization\)/);
  assert.match(council, /"delete_account"/);
  assert.match(council, /"suspend_account"/);
});

test("new safety incidents store restricted account attribution and sanitized evidence", () => {
  assert.match(safetyAgent, /actor_id:\s*context\.sender_id/);
  assert.match(safetyAgent, /target_id:\s*isMessage\s*\?\s*context\.receiver_id/);
  assert.match(safetyAgent, /source_origin:\s*safeOriginHost\(context\.source_origin\)/);
  assert.match(safetyAgent, /safeEvidenceExcerpt\(context\.evidence_excerpt\)/);
  assert.match(safetyAgent, /replace\(\/\[A-Z0-9\._%+-\]\+@\[/);
  assert.match(safetyAgent, /почта скрыта/);
  assert.match(safetyAgent, /ссылка скрыта/);
  assert.match(safetyAgent, /номер скрыт/);
  assert.match(safetyAgent, /\.slice\(0,\s*260\)/);
});

test("moderation binds the verified submitter context to the origin and text being reviewed", () => {
  assert.match(moderator, /safetyContext\.source_origin\s*=\s*req\.headers\.get\("origin"\)/);
  assert.match(moderator, /safetyContext\.evidence_excerpt\s*=\s*imageUrl\s*\?\s*null\s*:\s*value/);
});

test("safety report endpoint resolves identities only inside the current school", () => {
  assert.match(council, /profiles\?select=id,email,role&school_id=eq\./);
  assert.match(council, /&id=in\.\(/);
  assert.match(council, /identity_was_recorded:\s*!!row\.actor_id/);
  assert.match(council, /source_origin:\s*row\.source_origin/);
  assert.match(council, /evidence_excerpt:\s*row\.evidence_excerpt/);
  assert.match(council, /actor_id,target_id,source_origin,evidence_excerpt/);
  assert.match(council, /actor\.role !== "school_admin"/);
});

test("admin UI explains old anonymous records and safely displays source, identity and excerpt", () => {
  assert.match(frontend, /Автор не записывался в старых отчётах/);
  assert.match(frontend, /Кто отправил:/);
  assert.match(frontend, /Получатель:/);
  assert.match(frontend, /Источник сайта:/);
  assert.match(frontend, /Фрагмент:/);
  assert.match(frontend, /esc\(report\.evidence_excerpt\)/);
  assert.match(frontend, /esc\(actor\.email/);
});

test("new fields remain protected by the existing private-access policy model", () => {
  assert.match(migration, /add column if not exists actor_id uuid/i);
  assert.match(migration, /add column if not exists target_id uuid/i);
  assert.match(migration, /add column if not exists source_origin text/i);
  assert.match(migration, /add column if not exists evidence_excerpt text/i);
  assert.match(migration, /maximum 260 characters|maximum 260 characters/i);
  assert.doesNotMatch(migration, /disable row level security|grant select .*anon|grant select .*authenticated/i);
  assert.match(frontend, /profile\?\.role !== "school_admin"/);
});
