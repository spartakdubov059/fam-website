import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261110165908_notification_read_states.sql", import.meta.url),
  "utf8",
);
const frontend = readFileSync(
  new URL("../../index.html", import.meta.url),
  "utf8",
);

test("notification read states are isolated to the authenticated account", () => {
  assert.match(migration, /create table if not exists public\.notification_reads/i);
  assert.match(migration, /user_id uuid not null references auth\.users/i);
  assert.match(migration, /primary key \(user_id, notification_key\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.notification_reads from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant select, insert, update on table public\.notification_reads to authenticated/i);
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(migration, /with check \(\(select auth\.uid\(\)\) = user_id\)/i);
});

test("opening the bell marks visible notifications read and persists their state", () => {
  assert.match(frontend, /async function markNotificationsRead/);
  assert.match(frontend, /markNotificationsRead\(unreadIds\)/);
  assert.match(frontend, /upsert\(rows, \{ onConflict: "user_id,notification_key" \}\)/);
  assert.match(frontend, /update\(\{ is_read: true \}\)/);
  assert.match(frontend, /filter\(item => item\.isRead !== true\)\.length/);
});

test("manual notification removal is stored in the database", () => {
  assert.match(frontend, /notification_key: "dismissed:" \+ id/);
  assert.match(frontend, /dismissedIds/);
});

test("only safety-cleared ideas enter Council decision folders", () => {
  assert.match(frontend, /row\.ai_status === "approved"/);
  assert.match(frontend, /Дополнительная проверка безопасности/);
  assert.match(frontend, /Совету: автоматическая проверка безопасности не завершилась однозначно/);
});

test("the profile keeps one announcements section", () => {
  assert.equal((frontend.match(/id="profileListingsPanel"/g) || []).length, 1);
  assert.doesNotMatch(frontend, /class="profile-shortcuts"/);
});
