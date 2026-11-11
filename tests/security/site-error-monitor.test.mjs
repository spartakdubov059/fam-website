import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261110173255_fam_site_error_monitoring.sql", import.meta.url),
  "utf8",
);
const scheduleMigration = readFileSync(
  new URL("../../supabase/migrations/20261110181754_20261110180500_fam_agent_moscow_morning_schedule.sql", import.meta.url),
  "utf8",
);
const cronReadAccessMigration = readFileSync(
  new URL("../../supabase/migrations/20261111050302_fam_agent_worker_cron_read_access.sql", import.meta.url),
  "utf8",
);
const telemetryRoleMigration = readFileSync(
  new URL("../../supabase/migrations/20261111050303_fam_site_error_telemetry_anon_only.sql", import.meta.url),
  "utf8",
);
const technicalHealthMigration = readFileSync(
  new URL("../../supabase/migrations/20261110171353_add_read_only_fam_technical_health_agent.sql", import.meta.url),
  "utf8",
);
const currentHealthFunctionMigration = readFileSync(
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
  assert.match(migration, /'fam-agent-site-error-audit'[\s\S]*?'\*\/15 \* \* \* \*'/i);
});

test("Moscow migration preserves five-minute worker expectation and moves site-error audit hourly", () => {
  assert.match(
    migration,
    /'fam-agent-worker-every-5-minutes'\s*,\s*'\*\/5 \* \* \* \*'/i,
  );
  assert.match(
    scheduleMigration,
    /'fam-agent-site-error-audit'\s*,\s*'30 \* \* \* \*'/i,
  );
});

test("the technical worker gets only the cron metadata columns used by its health check", () => {
  assert.match(cronReadAccessMigration, /grant usage on schema cron to service_role/i);
  assert.match(cronReadAccessMigration, /grant select\s*\(jobid, jobname, schedule, active\)\s*on table cron\.job to service_role/i);
  assert.match(cronReadAccessMigration, /grant select\s*\(jobid, status, start_time\)\s*on table cron\.job_run_details to service_role/i);
  assert.doesNotMatch(cronReadAccessMigration, /to\s+(?:public|anon|authenticated)\b/i);
});

test("the scheduler health RPC stays invoker-only and executable only by the service role", () => {
  assert.match(technicalHealthMigration, /revoke all on function public\.get_fam_agent_task_system_health\(uuid,\s*text\)\s*from public, anon, authenticated/i);
  assert.match(technicalHealthMigration, /grant execute on function public\.get_fam_agent_task_system_health\(uuid,\s*text\)\s*to service_role/i);
  const functionStart = currentHealthFunctionMigration.indexOf("create or replace function public.get_fam_agent_task_system_health(");
  const functionEnd = currentHealthFunctionMigration.indexOf("$function$;", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.doesNotMatch(currentHealthFunctionMigration.slice(functionStart, functionEnd), /security\s+definer/i);
});

test("site-error telemetry is callable by anonymous browser requests without granting signed-in sessions", () => {
  assert.match(telemetryRoleMigration, /revoke execute on function public\.report_fam_site_error\(text,\s*text\)\s*from authenticated/i);
  assert.match(telemetryRoleMigration, /grant execute on function public\.report_fam_site_error\(text,\s*text\)\s*to anon/i);
  assert.doesNotMatch(telemetryRoleMigration, /grant execute on function public\.report_fam_site_error\([^;]*\bto\s+(?:public|authenticated)\b/i);
  const telemetryStart = frontend.indexOf('function reportFamSiteError(');
  const telemetryEnd = frontend.indexOf('\nwindow.onerror', telemetryStart);
  assert.ok(telemetryStart >= 0 && telemetryEnd > telemetryStart);
  assert.doesNotMatch(frontend.slice(telemetryStart, telemetryEnd), /authorization\s*:/i);
});
