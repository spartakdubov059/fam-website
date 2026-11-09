import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261109162500_school_scoped_agent_reports_and_free_analysts.sql", import.meta.url),
  "utf8",
);
const controller = readFileSync(
  new URL("../../supabase/functions/council-management/index.ts", import.meta.url),
  "utf8",
);
const frontend = readFileSync(
  new URL("../../index.html", import.meta.url),
  "utf8",
);

test("school reports and analyst proposals are private and school-scoped", () => {
  assert.match(migration, /create table private\.fam_agent_school_daily_reports/i);
  assert.match(migration, /primary key \(school_id, report_date\)/i);
  assert.match(migration, /alter table private\.fam_agent_ideas[\s\S]*?add column if not exists school_id text/i);
  assert.match(migration, /add column if not exists report_date date/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /using \(false\) with check \(false\)/i);
  assert.match(migration, /grant select, insert, update on table private\.fam_agent_school_daily_reports to service_role/i);
});

test("admin dashboard reads only ideas from the requested school", () => {
  assert.match(migration, /where r\.school_id = p_school_id/i);
  assert.match(migration, /where i\.school_id = p_school_id\s+and i\.status = 'pending'/i);
  assert.match(migration, /where i\.id = p_idea_id\s+and i\.school_id = v_reviewer_school_id\s+and i\.status = 'pending'/i);
});

test("browser roles cannot directly invoke admin RPCs", () => {
  assert.match(migration, /revoke all on function public\.get_fam_agent_admin_dashboard\(text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.get_fam_agent_admin_dashboard\(text\) to service_role/i);
  assert.match(migration, /revoke all on function public\.review_fam_agent_idea\(uuid, uuid, text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.review_fam_agent_idea\(uuid, uuid, text\) to service_role/i);
});

test("daily analyst jobs generate only aggregate, rule-based ideas without paid model calls", () => {
  assert.match(migration, /cron\.schedule\([\s\S]*?'fam-agent-school-daily-report'[\s\S]*?'0 6 \* \* \*'/i);
  assert.match(migration, /fam_safety_analyst/);
  assert.match(migration, /fam_council_analyst/);
  assert.match(migration, /fam_operations_analyst/);
  assert.match(migration, /fam_growth_analyst/);
  assert.match(migration, /rule-based analyst agents[\s\S]*?zero LLM\/API cost/i);
  assert.doesNotMatch(migration, /OPENAI_API_KEY|api\.openai\.com/i);
  assert.match(migration, /on conflict do nothing/i);
});

test("server checks school-admin role before dashboard and review actions", () => {
  const roleGate = controller.indexOf('if (actor.role !== "school_admin" || !actor.school_id)');
  const dashboardAction = controller.indexOf('if (action === "agent_dashboard")');
  const reviewAction = controller.indexOf('if (action === "review_agent_idea")');
  assert.ok(roleGate >= 0);
  assert.ok(dashboardAction > roleGate);
  assert.ok(reviewAction > roleGate);
  assert.match(controller, /rpc\/get_fam_agent_admin_dashboard/);
  assert.match(controller, /rpc\/review_fam_agent_idea/);
});

test("analyst decisions are recorded and only affect still-pending ideas", () => {
  assert.match(migration, /reviewed_by = p_reviewer_id/i);
  assert.match(migration, /reviewed_at = pg_catalog\.now\(\)/i);
  assert.match(migration, /p\.role = 'school_admin'/i);
  assert.match(controller, /recordAudit\(actor\.school_id, actorId, null, "fam_agent_idea_"/);
});

test("admin UI provides a private dashboard and explicit human review actions", () => {
  assert.match(frontend, /id="famAgentAdminPanel"/);
  assert.match(frontend, /data-action="refresh-agent-dashboard"/);
  assert.match(frontend, /data-action="review-fam-agent-idea"/);
  assert.match(frontend, /profile\?\.role !== "school_admin"/);
  assert.match(frontend, /Одобрить/);
  assert.match(frontend, /Отклонить/);
  assert.match(frontend, /не читают личные переписки/i);
});
