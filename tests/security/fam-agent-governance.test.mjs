import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_MARKER,
  findDisputes,
  inspectAgents,
  proposeRecruitment,
  makeReport,
  summarizeQwenRuns,
  summarizeAgentQueue,
  inspectPostMerge,
} from "../../scripts/fam-agent-governance.mjs";

const NOW = Date.parse("2026-11-13T19:00:00Z");
const earlier = (days) => new Date(NOW - days * 86_400_000).toISOString();

test("Qwen model failures are retried only within the configured attempt budget", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261123203000_fam_qwen_bounded_failure_retry.sql", import.meta.url), "utf8");
  assert.match(migration, /status='failed'[\s\S]*?result_summary='Локальный анализатор завершился с ошибкой\.'/);
  assert.match(migration, /attempt_count<t\.max_attempts/);
  assert.match(migration, /status='queued'[\s\S]*?retry_scheduled/);
  assert.match(migration, /active\.status in \('queued','claimed','in_progress'\)/);
  assert.ok(migration.indexOf("if p_worker_id is distinct") < migration.indexOf("with retryable_failures"));
});

test("Qwen workflow accepts the trusted INSPECTOR dispatch actor", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url), "utf8");
  const generateJob = workflow.split("  generate:")[1]?.split("  verify:")[0] ?? "";
  assert.match(generateJob, /github\.actor == 'spartakdubov059'/);
  assert.match(generateJob, /github\.actor == 'github-actions\[bot\]'/);
  assert.doesNotMatch(generateJob, /github\.event_name == 'workflow_dispatch'/);
  const inferenceSetup = generateJob.split("INFERENCE_HOME=")[1]?.split("HEARTBEAT_PID=")[0] ?? "";
  assert.match(inferenceSetup, /sudo -u fam-inference env -i/);
  assert.doesNotMatch(inferenceSetup, /pushd|popd/);
});

test("ARBITER detects only real code-file overlaps, not docs noise", () => {
  const found = findDisputes([
    { number: 2, files: ["docs/README.md", "index.html", "supabase/functions/f.ts"] },
    { number: 1, files: ["docs/README.md", "index.html", "supabase/functions/f.ts"] },
    { number: 3, files: ["docs/README.md"] },
  ]);
  assert.deepEqual(found, [{
    prs: [1, 2],
    files: ["index.html", "supabase/functions/f.ts"],
    highRisk: true,
  }]);
});

test("ARBITER skips incomplete file lists and missing data", () => {
  assert.deepEqual(findDisputes([
    { number: 1, files: null },
    { number: 2, files: ["index.html"] },
  ]), []);
});

test("INSPECTOR distinguishes repeated failures from a normal idle queue", () => {
  const normal = inspectAgents({ pulls: [], coderRuns: [], now: NOW });
  assert.deepEqual(normal, []);
  const failingRuns = [1, 2, 3].map((n) => ({
    id: n, created_at: earlier(n), status: "completed", conclusion: "failure",
  }));
  const found = inspectAgents({ pulls: [], coderRuns: failingRuns, now: NOW });
  assert.ok(found.some((w) => w.code === "repeated_failures" && w.count === 3));
  assert.equal(found.some((w) => w.code === "no_recent_run"), false);
});

test("INSPECTOR does not treat a draft PR awaiting approval as agent failure", () => {
  const found = inspectAgents({
    pulls: [
      { number: 5, draft: true, updated_at: earlier(9) },
      { number: 6, draft: false, updated_at: earlier(5) },
    ],
    coderRuns: [],
    now: NOW,
  });
  assert.deepEqual(found.filter((w) => w.code === "stale_prs")[0].prs, [6]);
});

test("INSPECTOR detects stuck runs and a missing schedule separately", () => {
  const found = inspectAgents({
    now: NOW,
    coderRuns: [
      { id: 11, created_at: earlier(3), status: "in_progress", conclusion: null },
    ],
  });
  assert.ok(found.some((w) => w.code === "stuck_runs"));
  assert.ok(found.some((w) => w.code === "no_recent_run"));
});

test("RECRUITER proposes a role only for demonstrated repeated gaps", () => {
  assert.deepEqual(proposeRecruitment(), []);
  assert.deepEqual(proposeRecruitment({ disputes: [{}, {}], warnings: [] }), []);
  const proposed = proposeRecruitment({
    disputes: [{}, {}, {}],
    warnings: [
      { code: "repeated_failures", count: 3 },
      { code: "stale_prs", count: 4 },
    ],
  });
  assert.deepEqual(proposed.map((p) => p.key),
    ["integration_specialist", "coder_diagnostician", "pr_triage"]);
  assert.ok(proposed.every((p) => /без /.test(p.permissions)));
});

test("Report escapes untrusted GitHub metadata and clarifies human authority", () => {
  const report = makeReport({
    now: NOW,
    count: 2,
    limited: true,
    disputes: [{
      prs: [1, 2], files: ["src/<script>alert(1)</script>.js"], highRisk: false,
    }],
    warnings: [],
    proposals: [],
  });
  assert.ok(report.includes(REPORT_MARKER));
  assert.ok(!report.includes("<script>"));
  assert.ok(report.includes("отчёт неполный"));
  assert.ok(report.includes("одобрения владельца"));
  assert.ok(report.includes("#1 ↔ #2"));
});

test("INSPECTOR flags failed post-merge workflows without triggering rollback", () => {
  const warnings = inspectPostMerge({ runs: [{ conclusion: "failure", event: "push", created_at: earlier(1) }], now: NOW });
  assert.equal(warnings[0].code, "postmerge_workflow_failure");
  assert.deepEqual(inspectPostMerge({ runs: [{ conclusion: "success", event: "push", created_at: earlier(1) }], now: NOW }), []);
  assert.equal(typeof summarizeQwenRuns, "function");
  assert.equal(typeof summarizeAgentQueue, "function");
});
