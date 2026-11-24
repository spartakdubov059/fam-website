import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../supabase/functions/submit-content/index.ts", import.meta.url), "utf8");
const sql = readFileSync(
  new URL("../../supabase/migrations/20261124203000_guard_same_school_message_recipients.sql", import.meta.url),
  "utf8"
);

test("message API verifies sender and recipient belong to the same school", () => {
  assert.match(source, /profiles\?select=id,school_id&id=eq\./);
  assert.match(source, /!profile\.school_id/);
  assert.match(source, /recipient\.school_id\s*!==\s*profile\.school_id/);
  const authPosition = source.indexOf("recipient.school_id !== profile.school_id");
  const moderationPosition = source.indexOf('kind: "message",');
  assert.ok(authPosition >= 0 && moderationPosition > authPosition,
    "school check must happen before content moderation and insertion");
});

test("message API binds listing discussions to a real participant owner", () => {
  assert.match(source, /listings\?select=id,school_id,user_id&id=eq\./);
  assert.match(source, /listing\.school_id\s*!==\s*profile\.school_id/);
  assert.match(source, /listing\.user_id\s*!==\s*userId\s*&&\s*listing\.user_id\s*!==\s*receiverId/);
});

test("database trigger enforces same-school recipients even on privileged inserts", () => {
  assert.match(sql, /create or replace function private\.fam_guard_message_school\(\)/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /sender_school\s+is\s+distinct\s+from\s+recipient_school/i);
  assert.match(sql, /l\.user_id\s+in\s*\(new\.sender_id,\s*new\.receiver_id\)/i);
  assert.match(sql, /before insert on public\.messages/i);
  assert.match(sql, /revoke all on function private\.fam_guard_message_school\(\)/i);
});
