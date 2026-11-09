import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261109203000_schedule_safe_fam_agent_queue.sql", import.meta.url),
  "utf8",
);

test("daily queue check is idempotently enqueued and marked as no-approval", () => {
  assert.match(migration, /fam-agent-enqueue-daily-queue-check/);
  assert.match(migration, /fam-queue-health-/);
  assert.match(migration, /approval_required, payload/);
  assert.match(migration, /'scheduled_audit',\s*false/);
  assert.match(migration, /unique index if not exists fam_agent_task_daily_schedule_key_uidx/);
});

test("database worker processes only the safe allowlisted task", () => {
  assert.match(migration, /t\.approval_required = false/);
  assert.match(migration, /t\.agent_key = 'quality'/);
  assert.match(migration, /t\.task_type = 'queue_health_check'/);
  assert.match(migration, /status = 'queued'/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /fam-agent-safe-queue-worker/);
});

test("worker reports queue counts only and does not inspect user data", () => {
  assert.match(migration, /count\(\*\) filter \(where status = 'queued'\)/);
  assert.match(migration, /Пользовательские данные не запрашивались/);
  assert.doesNotMatch(migration, /public\.(profiles|listings|messages|account_deletion_requests)/i);
  assert.doesNotMatch(migration, /service_role|SUPABASE_SECRET_KEY|FAM_AGENT_WORKER_TOKEN/i);
});

test("database cron execution is restricted to postgres", () => {
  assert.match(migration, /revoke all on function private\.process_fam_agent_safe_queue\(integer\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function private\.process_fam_agent_safe_queue\(integer\) to postgres/i);
  assert.match(migration, /revoke all on function private\.enqueue_fam_agent_daily_queue_check\(\) from public, anon, authenticated/i);
});
