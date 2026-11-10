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

test("agent dashboards stay out of the FAM UI while the separate server report pipeline remains available", () => {
  assert.doesNotMatch(frontend, /famAgentAdminPanel|famAgentReportSummary|famAgentIdeasList|loadFamAgentDashboard|refresh-agent-dashboard|review-fam-agent-idea|agent_dashboard/);
  assert.match(controller, /if \(action === "agent_dashboard"\)/);
  assert.match(controller, /rpc\/get_fam_agent_admin_dashboard/);
});

test("bell notifications use stable IDs and database-persistent account read and dismissal states", () => {
  assert.match(frontend, /NOTIFICATION_RELEASES/);
  assert.match(frontend, /NOTIFICATION_RELEASES\.forEach\(release => add\(/);
  assert.match(frontend, /from\("notification_reads"\)/);
  assert.match(frontend, /onConflict: "user_id,notification_key"/);
  assert.match(frontend, /data-action="mark-notification-read"/);
  assert.match(frontend, /data-action="dismiss-notification"/);
  assert.match(frontend, /markNotificationsRead\(unreadIds\)/);
  assert.doesNotMatch(frontend, /saveDismissedNotifications/);
  assert.doesNotMatch(frontend, /fam_notif_seen/);
});

test("chat unread state uses the database is_read flag instead of local timestamps", () => {
  assert.match(frontend, /\.or\("is_read\.eq\.false,is_read\.is\.null"\)/);
  assert.match(frontend, /\.update\(\{ is_read: true \}\)/);
  assert.match(frontend, /async function markChatSeen/);
  assert.doesNotMatch(frontend, /fam_chat_seen_map_/);
});

test("profile has one announcements section and no duplicate shortcut row", () => {
  assert.doesNotMatch(frontend, /class="profile-shortcuts"/);
  assert.equal((frontend.match(/id="profileListingsPanel"/g) || []).length, 1);
});

test("school admin cards identify accounts and their recent school publications", () => {
  assert.match(frontend, /Аккаунт #/);
  assert.match(frontend, /Публикации аккаунта:/);
  assert.match(frontend, /Автор:/);
  assert.match(controller, /price_text/);
  assert.match(controller, /description/);
  assert.match(controller, /event_date/);
  assert.match(frontend, /Объявление #/);
  assert.match(frontend, /Аккаунт #/);
});
