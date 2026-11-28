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
import {
  ownerApproval,
  exactPostMergeCI,
  exactBranchCI,
  classifyReviewState,
  collectCoderLifecycle,
  lifecycleStagesForRow,
  persistLifecycleRows,
  formatCoderLifecycle,
} from "../../scripts/fam-agent-lifecycle.mjs";

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

test("Qwen metrics require completed evidence for no-task, no-patch, QA and PR stages", () => {
  const base = { status: "completed", conclusion: "success", started_at: earlier(15), completed_at: earlier(1) };
  const generated = { ...base, name: "Локальная модель готовит исправление", steps: [
    { name: "Проверить настройки затрат до сборки модели", conclusion: "success" },
    { name: "Запустить локальную модель и подготовить patch", conclusion: "success" },
  ] };
  const noTask = { ...base, name: "Локальная модель готовит исправление", steps: [
    { name: "Проверить настройки затрат до сборки модели", conclusion: "success" },
    { name: "Скачать бесплатную модель с лицензией Apache 2.0", conclusion: "skipped" },
  ] };
  const qa = { ...base, name: "Независимая проверка без модели и секретов" };
  const pr = { ...base, name: "Подготовить PR и проверить исправление без публикации" };
  const successfulRun = (...jobs) => ({ status: "completed", conclusion: "success", jobs });
  const result = summarizeQwenRuns([
    successfulRun(noTask),
    { status: "completed", conclusion: "failure", jobs: [{ ...noTask, conclusion: "failure" }] },
    successfulRun(generated, { ...qa, conclusion: "skipped" }),
    { status: "in_progress", conclusion: null, jobs: [{ ...generated, status: "in_progress", conclusion: null }] },
    { status: "in_progress", conclusion: null, jobs: [generated, { ...qa, status: "queued", conclusion: null }] },
    successfulRun(generated, qa, pr),
    { status: "completed", conclusion: "failure", jobs: [generated, { ...qa, conclusion: "failure" }, pr] },
    { status: "completed", conclusion: "failure", jobs: [{ ...generated, conclusion: "failure" }, { ...qa, conclusion: "skipped" }] },
    { status: "completed", conclusion: "cancelled", jobs: [generated, { ...qa, conclusion: "skipped" }] },
    { status: "completed", conclusion: "timed_out", jobs: [generated, { ...qa, conclusion: "skipped" }] },
  ]);
  assert.equal(result.no_task, 1);
  assert.equal(result.model_no_patch, 1);
  assert.equal(result.model_result_unconfirmed, 5);
  assert.equal(result.model_generated, 2);
  assert.equal(result.qa_passed, 1);
  assert.equal(result.pr_created, 1);
  assert.equal(result.successful, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.timed_out, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.unconfirmed, 2);
});

test("Lifecycle approval and CI require exact commits and owner evidence", () => {
  const head = "a".repeat(40);
  const mergeSha = "b".repeat(40);
  const review = {
    id: 1, user: { login: "spartakdubov059" }, state: "APPROVED",
    submitted_at: "2026-11-26T10:00:00Z", commit_id: head,
  };
  assert.equal(ownerApproval([review], "spartakdubov059", head,
    "2026-11-26T11:00:00Z", "2026-11-26T09:00:00Z"), true);
  assert.equal(ownerApproval([review], "spartakdubov059", head,
    null, "2026-11-26T09:00:00Z", "2026-11-26T10:30:00Z"), false);
  assert.equal(ownerApproval([{
    ...review, submitted_at: "2026-11-26T10:40:00Z",
  }], "spartakdubov059", head, null,
  "2026-11-26T09:00:00Z", "2026-11-26T10:30:00Z"), true);
  assert.equal(ownerApproval([{ ...review, commit_id: mergeSha }],
    "spartakdubov059", head, "2026-11-26T11:00:00Z",
    "2026-11-26T09:00:00Z"), false);
  assert.equal(exactPostMergeCI([{
    id: 1, head_sha: mergeSha, head_branch: "main", event: "push",
    created_at: "2026-11-26T11:10:00Z", updated_at: "2026-11-26T11:20:00Z",
    status: "completed", conclusion: "success",
  }], mergeSha, "2026-11-26T11:00:00Z"), "verified");
  assert.equal(exactBranchCI([{
    id: 2, head_sha: head, head_branch: "codex/fam-run-123",
    event: "workflow_dispatch", created_at: "2026-11-26T10:10:00Z",
    updated_at: "2026-11-26T10:20:00Z",
    status: "completed", conclusion: "success",
  }], head, 123, "2026-11-26T10:00:00Z"), "verified");
  assert.equal(classifyReviewState({
    pr_created: true, pr_state: "closed_unmerged", merged: false,
  }), "closed_unmerged");
  assert.equal(classifyReviewState({
    pr_created: true, pr_state: "merged", merged: true, draft: false,
    owner_approved: false, branch_ci: "verified", postmerge: "verified",
  }), "merged_evidence_incomplete");
});

test("Lifecycle requires complete reopen history and ignores stale owner approvals", async () => {
  const head = "a".repeat(40);
  const openedAt = "2026-11-26T09:00:00Z";
  const reopenedAt = "2026-11-26T10:30:00Z";
  const baseRun = {
    id: 123,
    created_at: "2026-11-26T08:00:00Z",
    head_branch: "main",
    jobs: [
      { name: "Локальная модель готовит исправление", status: "completed", conclusion: "success",
        steps: [{ name: "Запустить локальную модель и подготовить patch", conclusion: "success" }] },
      { name: "Независимая проверка без модели и секретов", status: "completed", conclusion: "success" },
    ],
  };
  const pr = {
    number: 123, user: { login: "github-actions[bot]" },
    base: { ref: "main", repo: { full_name: "spartakdubov059/fam-website" } },
    head: { ref: "codex/fam-run-123", repo: { full_name: "spartakdubov059/fam-website" }, sha: head },
    created_at: openedAt, state: "open", merged: false, merged_at: null,
    draft: false, body: "FAM task ID: `11111111-1111-4111-8111-111111111111`",
  };
  const staleReview = {
    id: 1, user: { login: "spartakdubov059" }, state: "APPROVED",
    submitted_at: "2026-11-26T10:00:00Z", commit_id: head,
  };
  const readFor = (review, timeline = [{ event: "reopened", created_at: reopenedAt }]) =>
    async (path) => {
      if (path.startsWith("/pulls?")) return [pr];
      if (path === "/pulls/123") return pr;
      if (path === "/issues/123/timeline?per_page=100&page=1") return timeline;
      if (path === "/pulls/123/reviews?per_page=100") return [review];
      if (path.startsWith("/actions/workflows/")) return { workflow_runs: [] };
      throw new Error("Unexpected lifecycle evidence path");
    };
  const stale = await collectCoderLifecycle({
    runs: [baseRun], repository: "spartakdubov059/fam-website", read: readFor(staleReview),
  });
  assert.equal(stale.rows[0].review_history_complete, true);
  assert.equal(stale.rows[0].reopened_at, new Date(Date.parse(reopenedAt)).toISOString());
  assert.equal(stale.rows[0].owner_approved, false);

  const fresh = await collectCoderLifecycle({
    runs: [baseRun], repository: "spartakdubov059/fam-website",
    read: readFor({ ...staleReview, submitted_at: "2026-11-26T10:40:00Z" }),
  });
  assert.equal(fresh.rows[0].owner_approved, true);

  const incomplete = await collectCoderLifecycle({
    runs: [baseRun], repository: "spartakdubov059/fam-website",
    read: readFor({ ...staleReview, submitted_at: "2026-11-26T10:40:00Z" }, null),
  });
  assert.equal(incomplete.rows[0].review_history_complete, false);
  assert.equal(incomplete.rows[0].owner_approved, false);
});

test("Lifecycle persistence uses report classification and surfaces resolver failures", async () => {
  const approved = {
    task_id: "11111111-1111-4111-8111-111111111111",
    pr_number: 123, head_sha: "a".repeat(40), pr_created: true,
    pr_state: "open", merged: false, draft: false, owner_approved: true,
    branch_ci: "verified", postmerge: "unconfirmed",
  };
  assert.deepEqual(lifecycleStagesForRow(approved).map((stage) => stage.stage), ["owner_approved"]);
  const rejected = [{ ...approved }];
  await persistLifecycleRows(rejected, async () => ({ ok: true, resolved: false }));
  assert.equal(rejected[0].persistence.status, "rejected");
  assert.equal(rejected[0].persistence.stage, "owner_approved");
  const failed = [{ ...approved }];
  await persistLifecycleRows(failed, async () => { throw new Error("network failure"); });
  assert.equal(failed[0].persistence.status, "failed");
  const report = formatCoderLifecycle({ rows: rejected });
  assert.match(report, /Supabase отклонил переход/);

  const merged = {
    ...approved, pr_state: "merged", merged: true,
    merge_commit_sha: "b".repeat(40), postmerge: "verified",
  };
  assert.deepEqual(lifecycleStagesForRow(merged).map((stage) => stage.stage),
    ["owner_approved", "merged", "postmerge_verified"]);
  assert.equal(lifecycleStagesForRow({ ...merged, owner_approved: false }).length, 0);
});

test("Lifecycle migration preserves reopen and failed-CI recovery transitions", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261126195410_fam_agent_coder_lifecycle_resolution.sql", import.meta.url), "utf8");
  assert.match(migration, /for update/);
  assert.match(migration, /v_status := 'in_progress';[\s\S]*?Merge-коммит не прошёл/);
  assert.match(migration, /PR закрыт без merge; требуется повторно проверить reopened PR/);
  assert.match(migration, /PR закрыт без merge[\s\S]*?v_status := 'in_progress'/);
  assert.match(migration, /metadata->>'stage' = 'owner_approved'/);
  assert.match(migration, /revoke all on function public\.resolve_fam_agent_coder_lifecycle/);
  assert.match(migration, /grant execute on function public\.resolve_fam_agent_coder_lifecycle[\s\S]*?to service_role/);
  assert.match(migration, /p_worker_id is distinct from 'fam-agent-integrator-v1'/);
  assert.match(migration, /v_lifecycle_state := 'closed_unmerged';\s*v_head_sha := p_head_sha;/);
  const edge = readFileSync(new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url), "utf8");
  const governance = readFileSync(new URL("../../.github/workflows/fam-agent-governance.yml", import.meta.url), "utf8");
  const qwenWorkflow = readFileSync(new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url), "utf8");
  assert.match(edge, /FAM_AGENT_INTEGRATOR_TOKEN/);
  assert.match(edge, /body\.action === "resolve" \? INTEGRATOR_TOKEN : WORKER_TOKEN/);
  assert.match(edge, /p_worker_id: INTEGRATOR_ID/);
  assert.match(governance, /FAM_AGENT_INTEGRATOR_TOKEN: \$\{\{ secrets\.FAM_AGENT_INTEGRATOR_TOKEN \}\}/);
  assert.doesNotMatch(qwenWorkflow, /FAM_AGENT_INTEGRATOR_TOKEN/);
  assert.doesNotMatch(readFileSync(new URL("../../scripts/fam-agent-bridge.mjs", import.meta.url), "utf8"),
    /FAM_AGENT_INTEGRATOR_TOKEN/);
});

test("Lifecycle fails closed when decisive owner review evidence is malformed or duplicated", () => {
  const head = "a".repeat(40);
  const owner = "spartakdubov059";
  const approval = {
    id: 1, user: { login: owner }, state: "APPROVED",
    submitted_at: "2026-11-26T10:00:00Z", commit_id: head,
  };
  const revoked = { ...approval, id: 2, state: "CHANGES_REQUESTED" };
  for (const review of [
    { ...revoked, submitted_at: null },
    { ...revoked, id: 1 },
    { ...revoked, id: null },
    { ...revoked, user: null },
    { ...revoked, state: "UNKNOWN" },
    null,
  ]) assert.equal(ownerApproval([approval, review], owner, head), false);
  assert.equal(ownerApproval([approval, { ...revoked, state: "PENDING", submitted_at: null }], owner, head), true);
  assert.equal(ownerApproval([approval], owner, head), true);
});
