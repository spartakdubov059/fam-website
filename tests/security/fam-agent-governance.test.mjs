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
  formatMoscowTimestamp,
  shouldPublishGovernanceReport,
  renderLegalScopeStatus,
  mapLegalEvidenceScopes,
  renderDevelopmentScopeStatus,
} from "../../scripts/fam-agent-governance.mjs";

const NOW = Date.parse("2026-11-13T19:00:00Z");
const earlier = (days) => new Date(NOW - days * 86_400_000).toISOString();

test("Qwen retry recovery is restricted to recent infrastructure signals and retires stale queue entries", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261123210000_fam_qwen_retry_scope_and_stale_queue.sql", import.meta.url), "utf8");
  assert.match(migration, /task_key'='audit_agent_infrastructure/);
  assert.match(migration, /created_at >= pg_catalog\.now\(\)-interval '7 days'/);
  assert.match(migration, /status='queued' and t\.created_at < pg_catalog\.now\(\)-interval '7 days'/);
  assert.match(migration, /age of queue|устарело в очереди/);
  assert.ok(migration.indexOf("if p_worker_id is distinct") < migration.indexOf("with stale_queued"));
});

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

test("runtime smoke test has a separate seven-day deduplication key", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/fam-agent-governance.yml", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../supabase/migrations/20261123220000_fam_qwen_runtime_smoke_dedupe.sql", import.meta.url), "utf8");
  const governanceScript = readFileSync(new URL("../../scripts/fam-agent-governance.mjs", import.meta.url), "utf8");
  assert.match(workflow, /synthetic_qwen_runtime_smoke/);
  assert.match(governanceScript, /"runtime_smoke:"/);
  assert.match(migration, /p_event_id like 'runtime_smoke:%'/);
  assert.match(migration, /interval '7 days'/);
  assert.match(migration, /'scheduled_audit',false,[\s\S]*?\),\s*2\s*\)/);
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

test("INSPECTOR does not flag Qwen during its configured 180-minute workflow window", () => {
  for (const minutes of [179, 180, 190]) {
    const found = inspectAgents({
      now: NOW,
      coderRuns: [{
        id: 11,
        created_at: new Date(NOW - (minutes + 120) * 60_000).toISOString(),
        run_started_at: new Date(NOW - minutes * 60_000).toISOString(),
        status: "in_progress",
        conclusion: null,
      }],
    });
    assert.equal(found.some((warning) => warning.code === "stuck_runs"), false, `${minutes} minutes`);
  }
});

test("INSPECTOR flags an active Qwen run only after the workflow timeout and grace period", () => {
  const found = inspectAgents({
    now: NOW,
    coderRuns: [{
      id: 11,
      created_at: new Date(NOW - 311 * 60_000).toISOString(),
      run_started_at: new Date(NOW - 191 * 60_000).toISOString(),
      status: "in_progress",
      conclusion: null,
    }],
  });
  assert.ok(found.some((warning) => warning.code === "stuck_runs"));
  assert.match(found.find((warning) => warning.code === "stuck_runs").message, /180 минут и запас 10 минут/);
});

test("INSPECTOR ignores queued, malformed, or missing Qwen timestamps for stuck-run alerts", () => {
  const found = inspectAgents({
    now: NOW,
    coderRuns: [
      { id: 11, created_at: earlier(1), status: "queued", conclusion: null },
      { id: 12, created_at: "not-a-date", status: "in_progress", conclusion: null },
      { id: 13, status: "in_progress", conclusion: null },
    ],
  });
  assert.equal(found.some((warning) => warning.code === "stuck_runs"), false);
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

test("Boss report uses Moscow time and updates even when the scheduled day has no warnings", () => {
  assert.equal(formatMoscowTimestamp("2026-11-27T04:00:00Z"), "27.11.2026 07:00 МСК");
  assert.equal(shouldPublishGovernanceReport({ eventName: "schedule" }), true);
  assert.equal(shouldPublishGovernanceReport({ eventName: "workflow_dispatch" }), false);
  assert.equal(shouldPublishGovernanceReport({ eventName: "workflow_dispatch", warnings: [{ code: "issue" }] }), true);
  const workflow = readFileSync(new URL("../../.github/workflows/fam-agent-governance.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:[\s\S]*?cron: "0 4 \* \* \*"/);
  assert.match(makeReport({ now: Date.parse("2026-11-27T04:00:00Z") }), /Ежедневный доклад на 27\.11\.2026 07:00 МСК/);
});

test("Boss report shows separate unassessed LEGAL scopes and never implies release approval", () => {
  const report = makeReport({ now: NOW });
  assert.match(report, /LEGAL — раздельные статусы FAM/);
  assert.match(report, /FAM_CURRENT:[^\n]*не оценено/);
  assert.match(report, /FAM_RU:[^\n]*не оценено/);
  assert.match(report, /статус одного контура не переносится на другой/i);
  assert.match(report, /не являются юридическим заключением или разрешением на выпуск/);
  const unknown = renderLegalScopeStatus({ FAM_CURRENT: "owner_approved", FAM_RU: "merged" });
  assert.match(unknown, /FAM_CURRENT:[^\n]*не оценено/);
  assert.match(unknown, /FAM_RU:[^\n]*не оценено/);
});

test("LEGAL archive maps source observations only to pending human review and keeps scopes independent", () => {
  const mapped = mapLegalEvidenceScopes({
    FAM_CURRENT: { latest_status: "change_detected", observations_30d: 1 },
    FAM_RU: { latest_status: "source_unavailable", observations_30d: 0 },
  });
  assert.deepEqual(mapped, {
    FAM_CURRENT: "evidence_pending_human_review",
    FAM_RU: "source_unavailable",
  });
  const output = renderLegalScopeStatus(mapped);
  assert.match(output, /\*\*FAM_CURRENT:\*\* свидетельства ожидают независимой проверки человека/);
  assert.match(output, /\*\*FAM_RU:\*\* источник недоступен/);
  assert.doesNotMatch(output, /FAM_CURRENT:[^\n]*(?:одобрен|разрешён)/i);
  assert.match(output, /не являются юридическим заключением или разрешением на выпуск/);
  assert.deepEqual(mapLegalEvidenceScopes(null), { FAM_CURRENT: "not_assessed", FAM_RU: "not_assessed" });
});

test("Development Advisor report distinguishes current-site aggregates from unassessed FAM RU", () => {
  const report = makeReport({ now: NOW, developmentScopes: { FAM_CURRENT: "checked_no_signal", FAM_RU: "no_data" } });
  assert.match(report, /Советник по развитию — охват версий/);
  assert.match(report, /FAM_CURRENT:[^\n]*агрегаты проверены/);
  assert.match(report, /FAM_RU:[^\n]*не оценено/);
  assert.match(report, /Предложения относятся только к указанному контуру/);
  const unknown = renderDevelopmentScopeStatus({ FAM_CURRENT: "merged", FAM_RU: "approved" });
  assert.match(unknown, /FAM_CURRENT:[^\n]*не оценено/);
  assert.match(unknown, /FAM_RU:[^\n]*не оценено/);
});

test("INSPECTOR flags failed post-merge workflows without triggering rollback", () => {
  const warnings = inspectPostMerge({ runs: [{ conclusion: "failure", event: "push", created_at: earlier(1) }], now: NOW });
  assert.equal(warnings[0].code, "postmerge_workflow_failure");
  assert.deepEqual(inspectPostMerge({ runs: [{ conclusion: "success", event: "push", created_at: earlier(1) }], now: NOW }), []);
  assert.equal(typeof summarizeQwenRuns, "function");
  assert.equal(typeof summarizeAgentQueue, "function");
});
