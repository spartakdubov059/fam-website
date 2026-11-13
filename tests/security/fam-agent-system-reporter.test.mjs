import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  createDailyReport,
  renderDailyReport,
  sanitizePullRequests,
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
  failed_tasks_24h: [{ task_type: "coder_patch_request", count: 1 }],
};
const reportWorkflow = readFileSync(
  new URL("../../.github/workflows/fam-agent-daily-report.yml", import.meta.url),
  "utf8",
);

test("workflow runs are bounded to the last 24 hours and summarized by outcome", () => {
  const runs = summarizeWorkflowRuns([
    { name: "QA", status: "completed", conclusion: "success", created_at: "2026-11-13T05:00:00Z", run_number: 12, html_url: "https://github.com/a/b/actions/runs/12" },
    { name: "QA", status: "completed", conclusion: "failure", created_at: "2026-11-13T02:00:00Z", run_number: 11, html_url: "https://github.com/a/b/actions/runs/11" },
    { name: "old", status: "completed", conclusion: "success", created_at: "2026-11-11T02:00:00Z" },
  ], now);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].total_24h, 2);
  assert.equal(runs[0].success, 1);
  assert.equal(runs[0].failure, 1);
  assert.equal(runs[0].latest.run_number, 12);
});

test("PR report strips titles and accepts only trusted GitHub URLs", () => {
  const pulls = sanitizePullRequests([
    { number: 5, state: "open", draft: true, title: "private student data", html_url: "https://github.com/a/b/pull/5" },
    { number: 6, state: "open", title: "bad", html_url: "https://attacker.invalid/pull/6" },
    { number: 7, state: "closed", html_url: "https://github.com/a/b/pull/7" },
  ]);
  assert.deepEqual(pulls, [
    { number: 5, draft: true, html_url: "https://github.com/a/b/pull/5", created_at: null },
    { number: 6, draft: false, html_url: null, created_at: null },
  ]);
  assert.equal(JSON.stringify(pulls).includes("private student data"), false);
});

test("daily report states missing sources and records only allowlisted Supabase fields", () => {
  const report = createDailyReport({
    snapshot, snapshotStatus: "available",
    workflowRuns: [
      { name: "Moderation regression tests", status: "completed", conclusion: "success", created_at: "2026-11-13T05:00:00Z" },
      { name: "FAM local AI developer", status: "completed", conclusion: "success", created_at: "2026-11-13T05:30:00Z" },
    ],
    workflowStatus: "available",
    pullRequests: [{ number: 8, state: "open", title: "not included", draft: true, html_url: "https://github.com/a/b/pull/8" }],
    pullRequestStatus: "available",
    production: { status: "success", created_at: "2026-11-13T04:00:00Z", html_url: "https://github.com/a/b/deployments/1" },
    siteProbe: { status: "reachable", http_status: 200 },
    now,
  });
  assert.deepEqual(Object.keys(report.supabase).sort(), [
    "agent_statuses", "cron_jobs", "daily_report", "generated_at", "latest_coder_task",
    "latest_site_error_check", "latest_system_health", "report_date", "failed_tasks_24h",
  ]);
  assert.equal(report.workflows_24h.length, 2);
  assert.ok(report.role_statuses.some((role) => role.role === "QA" && role.status === "success"));
  assert.ok(report.role_statuses.some((role) => role.role === "Security Agent" && role.status === "coder_workflow_seen_individual_result_unavailable"));
  assert.equal(report.open_pull_requests[0].number, 8);
  assert.ok(report.role_statuses.some((role) => role.role === "Analyst" && role.status === "not_separately_instrumented"));
  assert.equal(JSON.stringify(report).includes("not included"), false);
  const markdown = renderDailyReport(report);
  assert.match(markdown, /ошибки 0/);
  assert.match(markdown, /последнее состояние: completed\/success/);
  assert.match(markdown, /PR #8 — draft/);
  assert.match(markdown, /coder_patch_request: 1 сбоев/);
  assert.match(markdown, /Публичный сайт: reachable \(HTTP 200\)/);
  assert.match(markdown, /Проверка сайта выполняется один раз в сутки/);
});

test("unavailable Supabase data never renders as a healthy or empty source", () => {
  const report = createDailyReport({ snapshotStatus: "unavailable", workflowStatus: "available", pullRequestStatus: "available", now });
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
  assert.doesNotMatch(reporterSource, /GITHUB_STEP_SUMMARY|upload-artifact/);
});
