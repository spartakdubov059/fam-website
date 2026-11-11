import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeCronRunHealth } from "../../supabase/functions/fam-agent-worker/cron-health.mjs";

const NOW = Date.parse("2026-11-11T09:15:00.000Z");
const expectedNames = [
  "fam-agent-worker-every-5-minutes",
  "fam-agent-school-daily-report",
  "fam-agent-orchestrator-daily-digest",
  "fam-agent-technical-system-health",
  "fam-agent-site-error-audit",
  "fam-agent-coder-task-producer",
];

function healthyJobs() {
  return expectedNames.map((job) => ({
    job,
    active: true,
    schedule_matches: true,
    last_run_status: "succeeded",
    last_run_at: new Date(NOW - 60_000).toISOString(),
  }));
}

test("Cron health passes only when every expected job has a fresh successful run", () => {
  const result = analyzeCronRunHealth(healthyJobs(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 6);
  assert.equal(result.successful, 6);
  assert.deepEqual(result.issues, []);
});

test("Qwen task producer is part of the monitored agent schedule", () => {
  const jobs = healthyJobs().filter((job) => job.job !== "fam-agent-coder-task-producer");
  const result = analyzeCronRunHealth(jobs, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.job === "fam-agent-coder-task-producer"));
});

test("a failed latest Cron execution makes system health fail", () => {
  const jobs = healthyJobs();
  jobs[0].last_run_status = "failed";

  const result = analyzeCronRunHealth(jobs, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) =>
    issue.job === expectedNames[0] && issue.reason.includes("failed")
  ));
});

test("a stale worker schedule is not reported as healthy even when enabled", () => {
  const jobs = healthyJobs();
  jobs[0].last_run_at = new Date(NOW - 16 * 60 * 1000).toISOString();

  const result = analyzeCronRunHealth(jobs, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) =>
    issue.job === expectedNames[0] && issue.reason.includes("устарел")
  ));
});

test("missing or malformed latest-run timestamps are reported", () => {
  const jobs = healthyJobs();
  jobs[1].last_run_at = null;

  const result = analyzeCronRunHealth(jobs, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) =>
    issue.job === expectedNames[1] && issue.reason.includes("время последнего запуска")
  ));
});

test("missing, duplicate, disabled, mismatched, and unknown schedules fail closed", () => {
  const jobs = healthyJobs().filter((job) => job.job !== expectedNames[4]);
  jobs[0].active = false;
  jobs[1].schedule_matches = false;
  jobs.push({ ...healthyJobs()[2] });
  jobs.push({
    job: "unexpected-agent-cron",
    active: true,
    schedule_matches: true,
    last_run_status: "succeeded",
    last_run_at: new Date(NOW).toISOString(),
  });

  const result = analyzeCronRunHealth(jobs, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.job === expectedNames[4]));
  assert.ok(result.issues.some((issue) => issue.job === expectedNames[0] && issue.reason.includes("выключено")));
  assert.ok(result.issues.some((issue) => issue.job === expectedNames[1] && issue.reason.includes("не совпадает")));
  assert.ok(result.issues.some((issue) => issue.job === expectedNames[2] && issue.reason.includes("дублируется")));
  assert.ok(result.issues.some((issue) => issue.job === "unexpected-agent-cron"));
});

test("SQL health RPC explicitly expects the Qwen task producer schedule", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/20261111183000_monitor_qwen_coder_producer_schedule.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /fam-agent-coder-task-producer/);
  assert.match(migration, /10 3 \* \* \*/);
  assert.match(migration, /get_fam_agent_task_system_health/);
});
