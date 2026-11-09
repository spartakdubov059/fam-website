import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261109150500_school_scoped_agent_reports_and_review_rpcs.sql", import.meta.url),
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

test("school daily report table is private and scoped to a school", () => {
  assert.match(migration, /create table private\.fam_agent_school_daily_reports/i);
  assert.match(migration, /primary key \(school_id, report_date\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /using \(false\) with check \(false\)/i);
  assert.match(migration, /grant select, insert, update on table private\.fam_agent_school_daily_reports to service_role/i);
});

test("admin dashboard RPCs are not executable by browser roles", () => {
  assert.match(migration, /revoke all on function public\.get_fam_agent_admin_dashboard\(text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.get_fam_agent_admin_dashboard\(text\) to service_role/i);
  assert.match(migration, /revoke all on function public\.review_fam_agent_idea\(uuid, uuid, text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.review_fam_agent_idea\(uuid, uuid, text\) to service_role/i);
});

test("server checks school-admin role before agent dashboard and review actions", () => {
  const roleGate = controller.indexOf('if (actor.role !== "school_admin" || !actor.school_id)');
  const dashboardAction = controller.indexOf('if (action === "agent_dashboard")');
  const reviewAction = controller.indexOf('if (action === "review_agent_idea")');
  assert.ok(roleGate >= 0);
  assert.ok(dashboardAction > roleGate);
  assert.ok(reviewAction > roleGate);
  assert.match(controller, /rpc\/get_fam_agent_admin_dashboard/);
  assert.match(controller, /rpc\/review_fam_agent_idea/);
});

test("proposal review changes only a still-pending idea and records the reviewer", () => {
  assert.match(migration, /where i\.id = p_idea_id\s+and i\.status = 'pending'/i);
  assert.match(migration, /reviewed_by = p_reviewer_id/i);
  assert.match(migration, /reviewed_at = pg_catalog\.now\(\)/i);
  assert.match(migration, /p\.role = 'school_admin'/i);
});

test("admin UI labels the reports and proposals and provides explicit human decisions", () => {
  assert.match(frontend, /id="famAgentAdminPanel"/);
  assert.match(frontend, /data-action="refresh-agent-dashboard"/);
  assert.match(frontend, /data-action="review-fam-agent-idea"/);
  assert.match(frontend, /Одобрить/);
  assert.match(frontend, /Отклонить/);
  assert.match(frontend, /profile\?\.role !== "school_admin"/);
  assert.match(frontend, /не меняет код и не запускает действия над аккаунтами/i);
});
