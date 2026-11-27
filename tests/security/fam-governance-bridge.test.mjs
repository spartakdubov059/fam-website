import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateQueueHealthResponse,
  fetchQueueHealth,
  inspectQueueHealth,
  validateAgentMetricsResponse,
  fetchAgentMetrics,
  validateDevelopmentAdvisorResponse,
  fetchDevelopmentAdvisorSnapshots,
  validateLegalEvidenceResponse,
  fetchLegalEvidenceSummary,
  validateModerationSummaryResponse,
  fetchModerationSummary,
  enqueueInspectorTask,
  mapInspectorWarning,
  validateInspectorEnqueueResponse,
} from "../../scripts/fam-governance-bridge.mjs";
import { buildModeratorRecommendations, makeReport, renderModerationStatus, REPORT_MARKER } from "../../scripts/fam-agent-governance.mjs";

const values = Object.freeze({
  queued: 2,
  claimed: 0,
  in_progress: 0,
  failed_last_24h: 3,
  expired_leases: 1,
  oldest_queued_minutes: 200,
});

const edge = readFileSync(
  new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url),
  "utf8"
);
const workflow = readFileSync(
  new URL("../../.github/workflows/fam-agent-governance.yml", import.meta.url),
  "utf8"
);
const governanceScript = readFileSync(new URL("../../scripts/fam-agent-governance.mjs", import.meta.url), "utf8");
const inspectorMigration = readFileSync(new URL(
  "../../supabase/migrations/20261123194000_fam_inspector_bounded_coder_enqueue.sql",
  import.meta.url,
), "utf8");

test("accepts only six safe queue counters, not raw data or identifying fields", () => {
  const clean = validateQueueHealthResponse({ ok: true, queue: values });
  assert.deepEqual({ ...clean }, values);
  assert.equal(Object.isFrozen(clean), true);
  for (const extra of ["user_id", "email", "task_id", "payload", "description", "title"]) {
    assert.throws(() => validateQueueHealthResponse({
      ok: true, queue: { ...values, [extra]: "private" },
    }));
  }
  for (const count of [-1, "3", 1.5, NaN, Infinity, 10000001]) {
    assert.throws(() => validateQueueHealthResponse({
      ok: true, queue: { ...values, queued: count },
    }));
  }
  assert.throws(() => validateQueueHealthResponse({ ok: true, queue: null }));
});

test("governance polls read-only health with a fixed authenticated POST", async () => {
  let captured;
  const result = await fetchQueueHealth({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "test-governance-token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ ok: true, queue: values }) };
    },
  });
  assert.equal(result.failed_last_24h, 3);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["x-fam-agent-token"], "test-governance-token");
  assert.deepEqual(JSON.parse(captured.options.body), { action: "health" });
  assert.equal("task_id" in JSON.parse(captured.options.body), false);
  assert.throws(() => validateQueueHealthResponse({ ok: false, queue: values }));
});

test("bridge failures are explicit and never reveal credentials", async () => {
  await assert.rejects(() => fetchQueueHealth({
    url: "http://localhost:8000", token: "test-governance-token",
    fetchImpl: async () => { throw Error("should not be called"); },
  }), /credentials unavailable/);
  await assert.rejects(() => fetchQueueHealth({
    url: "https://example.invalid", token: "test-governance-token",
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /health request failed/);
});

test("agent metrics client sends a fixed authenticated read-only action", async () => {
  let request;
  const result = await fetchAgentMetrics({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "test-governance-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true, metrics: [{ agent_key: "technical", status: "completed", count: 2 }] }) };
    },
  });
  assert.deepEqual(result, [{ agent_key: "technical", status: "completed", count: 2 }]);
  assert.deepEqual(JSON.parse(request.options.body), { action: "metrics" });
  assert.throws(() => validateAgentMetricsResponse({ ok: true, metrics: [{ agent_key: "technical", status: "completed", count: 1, user_id: "x" }] }));
});

test("development advisor bridge exposes only bounded listing aggregates", async () => {
  let request;
  const snapshots = [{ report_date: "2026-11-27", generated_at: "2026-11-27T06:00:00Z", active_listings: 12, new_listings_24h: 2 }];
  const result = await fetchDevelopmentAdvisorSnapshots({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "test-governance-token",
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ ok: true, snapshots }) };
    },
  });
  assert.deepEqual(result, snapshots);
  assert.deepEqual(JSON.parse(request.body), { action: "development_advisor_metrics" });
  assert.throws(() => validateDevelopmentAdvisorResponse({ ok: true, snapshots: [{ ...snapshots[0], user_id: "private" }] }));
  assert.throws(() => validateDevelopmentAdvisorResponse({ ok: true, snapshots: [{ ...snapshots[0], active_listings: -1 }] }));
  assert.match(edge, /get_fam_development_advisor_snapshots/);
  assert.match(workflow, /fam-development-advisor\.test\.mjs/);
});

test("LEGAL bridge exposes exactly two isolated source-check summaries, never legal approval details", async () => {
  let request;
  const legalEvidence = [
    { scope: "FAM_CURRENT", latest_checked_at: "2026-11-27T06:00:00Z", latest_status: "change_detected", observations_30d: 2 },
    { scope: "FAM_RU", latest_checked_at: null, latest_status: "not_assessed", observations_30d: 0 },
  ];
  const result = await fetchLegalEvidenceSummary({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "test-governance-token",
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ ok: true, legal_evidence: legalEvidence }) };
    },
  });
  assert.deepEqual(result.FAM_CURRENT, {
    latest_checked_at: "2026-11-27T06:00:00Z", latest_status: "change_detected", observations_30d: 2,
  });
  assert.deepEqual(result.FAM_RU, { latest_checked_at: null, latest_status: "not_assessed", observations_30d: 0 });
  assert.deepEqual(JSON.parse(request.body), { action: "legal_evidence_summary" });
  assert.equal(request.headers["x-fam-agent-token"], "test-governance-token");
  for (const unsafe of [
    { ok: true, legal_evidence: [{ ...legalEvidence[0], user_id: "private" }, legalEvidence[1]] },
    { ok: true, legal_evidence: [legalEvidence[0], legalEvidence[0]] },
    { ok: true, legal_evidence: [legalEvidence[0]] },
    { ok: true, legal_evidence: [{ ...legalEvidence[0], latest_status: "approved" }, legalEvidence[1]] },
    { ok: true, legal_evidence: [{ ...legalEvidence[0], observations_30d: "2" }, legalEvidence[1]] },
  ]) assert.throws(() => validateLegalEvidenceResponse(unsafe));
  assert.match(edge, /rpc\("get_fam_legal_evidence_summary", \{\}\)/);
  assert.match(edge, /body\.action === "legal_evidence_summary" && Object\.keys\(body\)\.length === 1/);
});

test("moderation bridge exposes only thresholded category buckets, never raw incident data", async () => {
  let request;
  const summary = {
    generated_at: "2026-11-27T06:00:00Z",
    total_bucket: "5_9",
    categories: [{ category: "targeted_harassment", severity: "medium", count_bucket: "5_9" }],
  };
  const result = await fetchModerationSummary({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "test-governance-token",
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ ok: true, summary }) };
    },
  });
  assert.deepEqual(result, summary);
  assert.deepEqual(JSON.parse(request.body), { action: "moderation_metrics" });
  assert.equal(request.headers["x-fam-agent-token"], "test-governance-token");
  for (const unsafe of [
    { ...summary, user_id: "private" },
    { ...summary, categories: [{ ...summary.categories[0], evidence_excerpt: "private" }] },
    { ...summary, categories: [{ category: "unknown", severity: "high", count_bucket: "5_9" }] },
    { ...summary, categories: [{ ...summary.categories[0], count_bucket: "1_4" }] },
    { ...summary, categories: [summary.categories[0], summary.categories[0]] },
    { ...summary, total_bucket: "suppressed" },
  ]) assert.throws(() => validateModerationSummaryResponse({ ok: true, summary: unsafe }));
  assert.match(edge, /get_fam_moderation_aggregate_summary/);
  assert.match(edge, /body\.action === "moderation_metrics"/);
  assert.match(workflow, /fam-governance-bridge\.test\.mjs/);
});

test("moderator report distinguishes no signal, suppressed data and unavailable source", () => {
  const none = renderModerationStatus({
    generated_at: "2026-11-27T06:00:00Z", total_bucket: "none", categories: [],
  }, "connected");
  assert.match(none, /школ с сигналами за последние 7 дней не обнаружено/);
  assert.match(none, /FAM_RU не оценён/);

  const suppressed = renderModerationStatus({
    generated_at: "2026-11-27T06:00:00Z", total_bucket: "suppressed", categories: [],
  }, "connected");
  assert.match(suppressed, /меньше пяти; данные скрыты/);

  const unavailable = renderModerationStatus(null, "unavailable");
  assert.match(unavailable, /результат неизвестен/);
  assert.doesNotMatch(makeReport(), /школ с сигналами за последние 7 дней не обнаружено/);
});

test("moderator recommendations are fixed QA-only guidance from thresholded categories", () => {
  const summary = {
    generated_at: "2026-11-27T06:00:00Z",
    total_bucket: "5_9",
    categories: [
      { category: "targeted_harassment", severity: "medium", count_bucket: "5_9" },
      { category: "threat_or_intimidation", severity: "high", count_bucket: "10_24" },
      { category: "unknown", severity: "high", count_bucket: "25_plus" },
      { category: "unsafe_image", severity: "critical", count_bucket: "5_9" },
    ],
  };
  const recommendations = buildModeratorRecommendations(summary);
  assert.equal(recommendations.length, 2);
  assert.ok(recommendations.every((item) => item.includes("синтетическ")));
  assert.ok(recommendations.every((item) => !/ученик|наказать|санкц|заблокировать/i.test(item)));

  for (const total_bucket of ["none", "suppressed"]) {
    assert.deepEqual(buildModeratorRecommendations({ ...summary, total_bucket }), []);
  }
  const report = renderModerationStatus(summary, "connected");
  assert.match(report, /Рекомендации для Испытателя \(QA\)/);
  assert.match(report, /без санкций, автоматических задач и изменений production/);
  assert.match(renderModerationStatus({ ...summary, total_bucket: "suppressed", categories: [] }, "connected"), /Рекомендаций по агрегату нет/);
});

test("INSPECTOR maps only high-confidence technical warnings to a fixed task allowlist", () => {
  assert.deepEqual(mapInspectorWarning({ code: "postmerge_workflow_failure", severity: "high", count: 2 }), {
    signal_code: "ci_workflow_failure", occurrences: 2,
  });
  assert.deepEqual(mapInspectorWarning({ code: "supabase_expired_leases", severity: "high", count: 0 }).occurrences, 1);
  for (const warning of [
    { code: "stale_prs", severity: "medium", count: 5 },
    { code: "postmerge_deployment", severity: "high", count: 1 },
    { code: "arbitrary", severity: "high", count: 1 },
  ]) assert.equal(mapInspectorWarning(warning), null);
});

test("INSPECTOR enqueue sends only a fixed code, synthetic event key, and bounded count", async () => {
  let request;
  const result = await enqueueInspectorTask({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "test-governance-token", signalCode: "synthetic_ci_workflow_failure",
    eventId: "synthetic:12345", occurrences: 1,
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ ok: true, task_created: true, task_id: "11111111-1111-4111-8111-111111111111", reason: "queued" }) };
    },
  });
  assert.deepEqual(result, { task_created: true, reason: "queued" });
  assert.deepEqual(JSON.parse(request.body), {
    action: "inspector_enqueue", signal_code: "synthetic_ci_workflow_failure", event_id: "synthetic:12345", occurrences: 1,
  });
  assert.equal(request.headers["x-fam-agent-token"], "test-governance-token");
  for (const body of [
    { ok: true, task_created: true, task_id: "not-uuid", reason: "queued" },
    { ok: true, task_created: false, reason: "contains student data" },
  ]) assert.throws(() => validateInspectorEnqueueResponse(body));
  await assert.rejects(() => enqueueInspectorTask({
    url: "https://example.invalid", token: "test-governance-token", signalCode: "freeform",
    eventId: "raw-log-text", occurrences: 1,
  }));
});

test("server queue uses dedup, seven-day cooldown, two attempts and no raw logs", () => {
  assert.match(inspectorMigration, /event_id text primary key/);
  assert.match(inspectorMigration, /interval '7 days'/);
  assert.ok(inspectorMigration.includes("'audit_agent_infrastructure'"));
  assert.match(inspectorMigration, /max_attempts/);
  assert.match(inspectorMigration, /'scheduled_audit',false[\s\S]*?\),\s*2\s*\)/);
  assert.match(inspectorMigration, /p_signal_code not in \([\s\S]*?'qwen_stuck_run'/);
  assert.doesNotMatch(inspectorMigration, /p_description|p_payload|raw_log|student_message/i);
  assert.match(workflow, /synthetic_signal/);
  assert.match(workflow, /actions: write/);
  assert.match(governanceScript, /GITHUB_EVENT_NAME === "workflow_dispatch"/);
  assert.match(governanceScript, /enqueueInspectorTask\(/);
  assert.match(governanceScript, /if \(result\.task_created\)[\s\S]*?actions\/workflows\/fam-codex-developer\.yml\/dispatches/);
  assert.doesNotMatch(governanceScript, /if \(result\.task_created\)[\s\S]*?gh pr merge/);
});

test("INSPECTOR differentiates healthy, failed and stalled aggregate queue", () => {
  assert.deepEqual(inspectQueueHealth({ ...values, failed_last_24h: 0, expired_leases: 0, queued: 0 }), []);
  const warningCodes = inspectQueueHealth(values).map((x) => x.code);
  assert.deepEqual(warningCodes, [
    "supabase_queue_failures", "supabase_expired_leases", "supabase_oldest_queued",
  ]);
  assert.deepEqual(inspectQueueHealth(null), []);
});

test("report marks disconnected bridge as unknown, never as healthy", () => {
  const notConfigured = makeReport({ count: 0 });
  assert.match(notConfigured, /Связь Supabase → GitHub не настроена/);
  assert.ok(notConfigured.includes(REPORT_MARKER));
  const failed = makeReport({ queueLink: "unavailable" });
  assert.match(failed, /здоровье очереди не подтверждено/);
  const connected = makeReport({ queueHealth: values, queueLink: "connected" });
  assert.match(connected, /с ошибками за сутки 3/);
  assert.doesNotMatch(connected, /test-governance-token|user_id|payload/);
});

test("edge function requires server token and exposes only fixed aggregate RPC on health", () => {
  assert.match(edge, /if \(!await sameSecret\(/);
  assert.match(edge, /origin_not_allowed/);
  assert.match(edge, /body\.action === "health" && Object\.keys\(body\)\.length === 1/);
  assert.match(edge, /rpc\("get_fam_agent_queue_health", \{\}\)/);
  assert.match(edge, /return json\(\{ ok: true, queue: safe, diagnostic_id: diagnosticId \}, 200, diagnosticId\)/);
  assert.doesNotMatch(edge, /rpc\(body\./);
  assert.match(workflow, /FAM_AGENT_BRIDGE_URL: \$\{\{ secrets\.FAM_AGENT_BRIDGE_URL \}\}/);
  assert.match(workflow, /FAM_AGENT_WORKER_TOKEN: \$\{\{ secrets\.FAM_AGENT_WORKER_TOKEN \}\}/);
  assert.match(workflow, /github\.event_name != 'pull_request'/);
  assert.match(workflow, /contents: read/);
  assert.match(edge, /body\.action === "inspector_enqueue"/);
  assert.match(edge, /rpc\("enqueue_fam_agent_inspector_task"/);
  assert.doesNotMatch(edge, /INSPECTOR_SIGNALS\.has\(body\.signal_code\)[\s\S]*?body\.description/);
  assert.doesNotMatch(workflow, /gh pr merge/);
});
