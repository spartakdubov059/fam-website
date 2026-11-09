import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../supabase/migrations/20261109134709_correct_event_registration_cancellation_rpc.sql", import.meta.url),
  "utf8",
);

test("the UI calls the protected cancellation RPC instead of deleting directly", () => {
  const match = frontend.match(/async function cancelRegAction\(regId\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, "cancelRegAction must exist");
  assert.match(match[1], /sb\.rpc\(["']cancel_own_event_registration["']/);
  assert.doesNotMatch(match[1], /from\(["']event_registrations["']\)\.delete\(/);
});

test("the database RPC restricts deletion to the authenticated user's own active registration", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.cancel_own_event_registration/);
  assert.match(migration, /v_user_id := auth\.uid\(\)/);
  assert.match(migration, /DELETE FROM public\.event_registrations[\s\S]*?WHERE id = p_registration_id[\s\S]*?AND user_id = v_user_id[\s\S]*?AND status IN \('pending', 'confirmed'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.cancel_own_event_registration\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.cancel_own_event_registration\(uuid\)[\s\S]*?TO authenticated/);
});
