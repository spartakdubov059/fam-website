import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeAgentQueue, summarizeQwenRuns, makeReport } from "../../scripts/fam-agent-governance.mjs";
import { validateAgentMetricsResponse } from "../../scripts/fam-governance-bridge.mjs";

const migration = readFileSync(new URL("../../supabase/migrations/20261123013500_fam_agent_task_metrics.sql", import.meta.url), "utf8");
const recovery = readFileSync(new URL("../../supabase/migrations/20261123013000_fam_qwen_retry_recovery.sql", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url), "utf8");

test("metrics endpoint accepts only fixed aggregate agent and task states", () => {
  const rows = validateAgentMetricsResponse({ ok: true, metrics: [
    { agent_key: "technical", status: "completed", count: 12 },
  ] });
  assert.deepEqual(rows, [{ agent_key: "technical", status: "completed", count: 12 }]);
  for (const metrics of [
    [{ agent_key: "technical", status: "completed", count: 1, payload: "private" }],
    [{ agent_key: "unknown", status: "completed", count: 1 }],
    [{ agent_key: "technical", status: "completed", count: "1" }],
  ]) assert.throws(() => validateAgentMetricsResponse({ ok: true, metrics }));
  assert.match(bridge, /body\.action === "metrics" && Object\.keys\(body\)\.length === 1/);
  assert.match(bridge, /rpc\("get_fam_agent_task_metrics", \{\}\)/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /revoke all on function public\.get_fam_agent_task_metrics[^;]+from public,anon,authenticated/i);
});

test("metrics distinguish no-task, analysis, generation, independent QA and PR", () => {
  const base = { status: "completed", conclusion: "success", run_minutes: 14, created_at: "2026-11-23T00:00:00Z", updated_at: "2026-11-23T00:15:00Z" };
  const runs = summarizeQwenRuns([
    { ...base, id: 1, jobs: [{ name: "Локальная модель готовит исправление", status: "completed", conclusion: "success", started_at: base.created_at, completed_at: base.updated_at, steps: [{ name: "Проверить настройки затрат до сборки модели", conclusion: "success" }, { name: "Скачать бесплатную модель с лицензией Apache 2.0", conclusion: "skipped" }] }] },
    { ...base, id: 2, jobs: [{ name: "Локальная модель готовит исправление", status: "completed", conclusion: "success", started_at: base.created_at, completed_at: base.updated_at, steps: [{ name: "Запустить локальную модель и подготовить patch", conclusion: "success" }] }, { name: "Независимая проверка без модели и секретов", status: "completed", conclusion: "success" }, { name: "Подготовить PR и проверить исправление без публикации", status: "completed", conclusion: "success" }] },
  ]);
  assert.equal(runs.no_task, 1);
  assert.equal(runs.model_generated, 1);
  assert.equal(runs.qa_passed, 1);
  assert.equal(runs.pr_created, 1);
  const agents = summarizeAgentQueue([
    { agent_key: "technical", status: "completed", count: 2 },
    { agent_key: "technical", status: "failed", count: 1 },
    { agent_key: "technical", status: "in_progress", count: 1 },
  ]);
  assert.deepEqual(agents, [{ agent: "technical", total: 4, completed: 2, failed: 1, active: 1 }]);
  const report = makeReport({ agentMetrics: agents, qwenMetrics: runs });
  assert.match(report, /no_patch 0/);
  assert.match(report, /независимая QA прошла 1/);
  assert.match(report, /тайм-ауты 0/);
  assert.match(report, /отменены 0/);
  assert.match(report, /не завершены или не подтверждены 0/);
  assert.match(report, /runner-минуты/);
});

test("expired Qwen leases retry only within attempt limit and clear stale lifecycle", () => {
  assert.match(recovery, /t\.claimed_by = p_worker_id/);
  assert.match(recovery, /t\.attempt_count < t\.max_attempts/i);
  assert.match(recovery, /set status = 'queued'/);
  assert.match(recovery, /started_at = null/);
  assert.match(recovery, /result_summary = 'Ограниченное техническое задание принято локальным анализатором\.'/);
  assert.match(recovery, /for update skip locked/i);
  assert.match(recovery, /least\(greatest\(coalesce\(p_limit, 1\), 1\), 1\)/i);
  assert.doesNotMatch(recovery, /delete from private\.fam_agent_tasks/i);
});

