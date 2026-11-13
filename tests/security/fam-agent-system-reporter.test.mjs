import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  createDailyReport,
  renderDailyReport,
  sanitizePullRequests,
  summarizePullRequestChecks,
  summarizeAgentJobStatuses,
  summarizeWorkflowRuns,
} from "../../scripts/fam-agent-system-reporter.mjs";

const now = new Date("2026-11-13T06:00:00.000Z");
const snapshot = {
  generated_at: "2026-11-13T04:00:00.000Z",
  report_date: "2026-11-13",
  daily_report: { report_date: "2026-11-13", generated_at: "2026-11-13T04:00:00.000Z" },
  agent_statuses: [{ agent_key: "technical", queued: 1, in_progress: 0, blocked: 0, completed_24h: 2, failed_24h: 1 }],
  cron_jobs: [{ jobname: "fam-agent-worker-every-5-minutes", schedule: "*/5 * * * *", active: true, last_run_status: "succeeded", last_run_at: "2026-11-13T05:55:00Z" }],
  latest_system_health: { status: "completed", updated_at: "2026-11-13T03:40:00Z" },
  latest_coder_task: { status: "failed", updated_at: "2026-11-13T03:15:00Z" },
  latest_site_error_check: { status: "completed", updated_at: "2026-11-13T05:30:00Z" },
  worker_http_6h: { window_hours: 6, observed_from: "2026-11-13T00:00:00Z", response_count: 4, success_count: 3, http_error_count: 1, reported_error_count: 1 },
  failed_tasks_24h: [{ task_type: "coder_patch_request", count: 1 }],
  site_error_events_24h: [{ event_code: "js_runtime", page_area: "listings", occurrences: 4 }],
};
const reportWorkflow = readFileSync(
  new URL("../../.github/workflows/fam-agent-daily-report.yml", import.meta.url),
  "utf8",
);
const edgeBridgeSource = readFileSync(
  new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url),
  "utf8",
);
const reportMigration = readFileSync(
  new URL("../../supabase/migrations/20261113090000_add_fam_agent_report_snapshot_rpc.sql", import.meta.url),
  "utf8",
);

test("workflow runs are bounded to the last 24 hours and summarized by outcome", () => {
  const runs = summarizeWorkflowRuns([
    { id: 120, name: "QA", status: "completed", conclusion: "success", created_at: "2026-11-13T05:00:00Z", run_number: 12, html_url: "https://github.com/a/b/actions/runs/12" },
    { name: "QA", status: "completed", conclusion: "failure", created_at: "2026-11-13T02:00:00Z", run_number: 11, html_url: "https://github.com/a/b/actions/runs/11" },
    { name: "old", status: "completed", conclusion: "success", created_at: "2026-11-11T02:00:00Z" },
  ], now);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].total_24h, 2);
  assert.equal(runs[0].success, 1);
  assert.equal(runs[0].failure, 1);
  assert.equal(runs[0].latest.run_number, 12);
  assert.equal(runs[0].latest.run_id, 120);
});

test("PR checks report only allowlisted latest outcomes and omit untrusted check metadata", () => {
  const summary = summarizePullRequestChecks([
    { name: "Russian content safety tests", status: "completed", conclusion: "failure", started_at: "2026-11-13T04:00:00Z", output: { text: "private" } },
    { name: "Russian content safety tests", status: "completed", conclusion: "success", started_at: "2026-11-13T05:00:00Z" },
    { name: "coder-qa-postgres", status: "in_progress", started_at: "2026-11-13T05:30:00Z" },
    { name: "untrusted check name with private text", status: "completed", conclusion: "failure" },
  ]);
  assert.deepEqual(summary, {
    status: "available",
    checks: [
      { key: "coder_qa", status: "in_progress" },
      { key: "regression", status: "success" },
    ],
  });
  assert.deepEqual(summarizePullRequestChecks([]), { status: "not_observed", checks: [] });
  assert.deepEqual(summarizePullRequestChecks(null), { status: "unavailable", checks: [] });
});

test("PR report strips titles and accepts only trusted GitHub URLs", () => {
  const pulls = sanitizePullRequests([
    { number: 5, state: "open", draft: true, title: "private student data", html_url: "https://github.com/a/b/pull/5" },
    { number: 6, state: "open", title: "bad", html_url: "https://attacker.invalid/pull/6" },
    { number: 7, state: "closed", html_url: "https://github.com/a/b/pull/7" },
  ]);
  assert.deepEqual(pulls, [
    { number: 5, draft: true, html_url: "https://github.com/a/b/pull/5", created_at: null, checks: { status: "unavailable", checks: [] } },
    { number: 6, draft: false, html_url: null, created_at: null, checks: { status: "unavailable", checks: [] } },
  ]);
  assert.equal(JSON.stringify(pulls).includes("private student data"), false);
});

test("patch-specific GitHub jobs expose only bounded role outcomes", () => {
  const statuses = summarizeAgentJobStatuses([
    {
      name: "Локальная модель готовит исправление",
      steps: [{ name: "Запустить локальную модель и подготовить patch", status: "completed", conclusion: "success" }],
    },
    {
      name: "Независимая проверка без модели и секретов",
      status: "completed",
      conclusion: "failure",
      steps: [
        { name: "Подготовить независимый статический Reviewer отчёт", status: "completed", conclusion: "success" },
        { name: "Запустить отдельный статический Security Agent", status: "completed", conclusion: "failure" },
        { name: "Запустить отдельный статический Performance Agent", status: "completed", conclusion: "skipped" },
      ],
    },
    { name: "Подготовить PR и проверить исправление без публикации", status: "completed", conclusion: "skipped" },
    { name: "Untrusted job name with private text", conclusion: "failure" },
  ]);
  assert.deepEqual(statuses, {
    coder: "success",
    qa: "failure",
    reviewer: "success",
    security: "failure",
    performance: "skipped",
    pr_manager: "skipped",
  });
  assert.equal(JSON.stringify(statuses).includes("Untrusted"), false);
  assert.equal(summarizeAgentJobStatuses(null), null);
});

test("daily report states missing sources and records only allowlisted Supabase fields", () => {
  const report = createDailyReport({
    snapshot, snapshotStatus: "available",
    workflowRuns: [
      { name: "Moderation regression tests", status: "completed", conclusion: "success", created_at: "2026-11-13T05:00:00Z" },
      { id: 77, name: "FAM local AI developer", status: "completed", conclusion: "success", created_at: "2026-11-13T05:30:00Z" },
    ],
    workflowStatus: "available",
    agentJobStatus: "available",
    agentJobStatuses: { coder: "success", qa: "success", reviewer: "success", security: "success", performance: "failure", pr_manager: "skipped" },
    pullRequests: [{ number: 8, state: "open", title: "not included", draft: true, html_url: "https://github.com/a/b/pull/8" }],
    pullRequestStatus: "available",
    production: { status: "success", created_at: "2026-11-13T04:00:00Z", html_url: "https://github.com/a/b/deployments/1" },
    siteProbe: { status: "reachable", http_status: 200 },
    now,
  });
  assert.deepEqual(Object.keys(report.supabase).sort(), [
    "agent_statuses", "cron_jobs", "daily_report", "failed_tasks_24h", "generated_at", "latest_coder_task",
    "latest_site_error_check", "latest_system_health", "report_date", "site_error_events_24h", "worker_http_6h",
  ]);
  assert.equal(report.workflows_24h.length, 2);
  assert.ok(report.role_statuses.some((role) => role.role === "QA" && role.status === "patch:success;regression:success"));
  assert.ok(report.role_statuses.some((role) => role.role === "Security Agent" && role.status === "success"));
  assert.equal(report.open_pull_requests[0].number, 8);
  assert.ok(report.role_statuses.some((role) => role.role === "Analyst" && role.status === "hypotheses_available"));
  assert.ok(report.role_statuses.some((role) => role.role === "Monitoring" && /worker_http:3\/4_success;http_errors:1/.test(role.status)));
  assert.deepEqual(report.supabase.worker_http_6h, snapshot.worker_http_6h);
  assert.ok(report.role_statuses.some((role) => role.role === "Performance Agent" && role.status === "failure"));
  assert.equal(JSON.stringify(report).includes("not included"), false);
  const markdown = renderDailyReport(report);
  assert.match(markdown, /ошибки 0/);
  assert.match(markdown, /последнее состояние: completed\/success/);
  assert.match(markdown, /PR #8 — draft; проверки: недоступны/);
  assert.match(markdown, /coder_patch_request: 1 сбоев/);
  assert.match(markdown, /Аналитические гипотезы по техническим сигналам/);
  assert.match(markdown, /без stack trace/);
  assert.match(markdown, /Публичный сайт: reachable \(HTTP 200\)/);
  assert.match(markdown, /Ответы Edge Worker по pg_net \(окно до 6 ч\): 3\/4 успешных распознанных ответов; HTTP-ошибок: 1; ошибок, сообщённых Worker: 1/);
  assert.match(markdown, /Самый ранний сохранённый ответ: 2026-11-13T00:00:00Z/);
  assert.match(markdown, /Проверка сайта выполняется один раз в сутки/);
});

test("unavailable Supabase data never renders as a healthy or empty source", () => {
  const report = createDailyReport({ snapshotStatus: "unavailable", workflowStatus: "available", pullRequestStatus: "available", agentJobStatus: "not_run_24h", now });
  const markdown = renderDailyReport(report);
  assert.equal(report.supabase, null);
  assert.match(markdown, /Supabase: unavailable/);
  assert.match(markdown, /Снимок Supabase недоступен/);
});

test("report workflow reads sources but does not publish private report contents", () => {
  assert.ok(reportWorkflow.includes('cron: "15 4 * * *"'));
  assert.match(reportWorkflow, /actions: read/);
  assert.match(reportWorkflow, /pull-requests: read/);
  assert.match(reportWorkflow, /deployments: read/);
  assert.doesNotMatch(reportWorkflow, /(?:contents|actions|deployments|pull-requests): write/);
  assert.doesNotMatch(reportWorkflow, /upload-artifact|GITHUB_STEP_SUMMARY/);
  const reporterSource = readFileSync(new URL("../../scripts/fam-agent-system-reporter.mjs", import.meta.url), "utf8");
  assert.match(reporterSource, /action: "save_report"/);
  assert.match(reporterSource, /actions\/runs\/.*\/jobs\?per_page=100/);
  assert.match(reporterSource, /actions\/runs\?branch=main&per_page=100/);
  assert.match(reporterSource, /commits\/" \+ sha \+ "\/check-runs\?per_page=100/);
  assert.match(reportWorkflow, /checks: read/);
  assert.ok(reporterSource.includes("summarizeAgentJobStatuses"));
  assert.doesNotMatch(reporterSource, /GITHUB_STEP_SUMMARY|upload-artifact/);
});

test("Reporter output fields match the Edge bridge and SQL persistence allowlists", () => {
  const report = createDailyReport({ now });
  const declaration = edgeBridgeSource.match(/const REPORT_FIELDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  const edgeFields = [...declaration.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(edgeFields, Object.keys({ ...report, markdown: renderDailyReport(report) }).sort());
  assert.match(declaration, /"role_statuses"/);
  assert.match(declaration, /"technical_analysis"/);
  assert.match(reportMigration, /'open_pull_requests','role_statuses','technical_analysis','production_deployment'/);
  assert.match(reportMigration, /from net\._http_response as r/);
  assert.match(reportMigration, /'reported_error_count'/);
});
