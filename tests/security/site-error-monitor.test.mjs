import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261110173255_fam_site_error_monitoring.sql", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../../supabase/functions/fam-agent-worker/index.ts", import.meta.url),
  "utf8",
);
const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("frontend telemetry stores only fixed aggregate error categories", () => {
  assert.match(migration, /create table if not exists private\.fam_site_error_counts/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /grant execute on function public\.report_fam_site_error\(text,text\) to anon,authenticated/i);
  assert.match(frontend, /report_fam_site_error/);
  assert.match(frontend, /p_event_code: eventCode, p_page_area: pageArea/);
  assert.doesNotMatch(frontend, /JSON\.stringify\(\{\s*p_event_code:[^}]*?(?:message|stack|email|password|user_id)/i);
  assert.match(migration, /interval '30 days'/i);
});

test("only a claimed technical site-error task can read the aggregate digest", () => {
  assert.match(migration, /t\.task_type='site_error_digest'/i);
  assert.match(migration, /t\.claimed_by=p_worker_id/i);
  assert.match(migration, /grant execute on function public\.get_fam_agent_task_site_error_digest\(uuid,text\) to service_role/i);
  assert.match(worker, /task_type === "site_error_digest"/);
  assert.match(worker, /get_fam_agent_task_site_error_digest/);
  assert.match(worker, /p_task_id: task\.id/);
});

test("worker claims only the allowlisted non-destructive monitoring task", () => {
  assert.match(migration, /t\.agent_key='technical' and t\.task_type='site_error_digest'/i);
  assert.match(worker, /const siteErrorTask = task\?\.agent_key === "technical"/);
  assert.match(worker, /const safeTask = queueHealthTask \|\| dailyReportTask \|\| systemHealthTask \|\| siteErrorTask/);
});

test("site-error audit is scheduled and included in infrastructure health checks", () => {
  assert.match(migration, /'fam-agent-site-error-audit'[\s\S]*?'\*\/15 \* \* \*'/i);
});
