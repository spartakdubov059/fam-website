import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261111182622_recover_expired_fam_coder_tasks_after_final_attempt.sql", import.meta.url),
  "utf8",
);

test("Qwen claim function closes expired leases after the final permitted attempt", () => {
  assert.match(migration, /create or replace function public\.claim_fam_agent_coder_tasks/i);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /with exhausted as \(/i);
  assert.match(migration, /t\.status in \('claimed', 'in_progress'\)/i);
  assert.match(migration, /t\.lease_expires_at <= pg_catalog\.now\(\)/i);
  assert.match(migration, /t\.attempt_count >= t\.max_attempts/i);
  assert.match(migration, /set status = 'failed'/i);
  assert.match(migration, /claimed_by = null/i);
  assert.match(migration, /lease_expires_at = null/i);
  assert.match(migration, /insert into private\.fam_agent_task_events/i);
});

test("Qwen retry recovery preserves worker-only RPC access and atomic allowlisted claims", () => {
  assert.match(migration, /revoke all on function public\.claim_fam_agent_coder_tasks[^;]+from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.claim_fam_agent_coder_tasks[^;]+to service_role/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /t\.approval_required = false/i);
  assert.match(migration, /t\.source in \('system', 'scheduled_audit'\)/i);
  assert.match(migration, /audit_frontend_runtime/i);
  assert.match(migration, /audit_client_resilience/i);
  assert.match(migration, /audit_accessibility/i);
  assert.doesNotMatch(migration, /drop table|delete from private\.fam_agent_tasks/i);
});
