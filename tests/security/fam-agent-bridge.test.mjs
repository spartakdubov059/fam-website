import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_PROMPTS,
  validateClaimResponse,
  chooseResultCode,
  readTaskSummary,
  bridgeRequest,
  shouldRunModel,
} from "../../scripts/fam-agent-bridge.mjs";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("accepts a single allowlisted aggregate task", () => {
  const task = validateClaimResponse({
    ok: true,
    task: {
      id,
      task_key: "audit_frontend_runtime",
      event_code: "js_runtime",
      page_area: "other",
      occurrences: 7,
    },
  });
  assert.equal(task.id, id);
  assert.match(task.prompt, /js_runtime/);
  assert.match(task.prompt, /index\.html/);
  assert.match(task.prompt, /window\.onerror/);
  assert.match(task.prompt, /window\.onunhandledrejection/);
  assert.equal(Object.keys(TASK_PROMPTS).length, 3);
});

test("accepts an empty queue", () => {
  assert.equal(validateClaimResponse({ ok: true, task: null }), null);
});

test("rejects unapproved task keys and malformed task identifiers", () => {
  assert.throws(() => validateClaimResponse({
    ok: true, task: { id, task_key: "run_sql", event_code: "js_runtime", page_area: "other", occurrences: 1 },
  }));
  assert.throws(() => validateClaimResponse({
    ok: true, task: { id: "not-a-uuid", task_key: "audit_accessibility", event_code: "js_runtime", page_area: "other", occurrences: 1 },
  }));
});

test("rejects non-aggregate and out-of-range payloads", () => {
  for (const occurrences of [-1, 1001, 1.5, "4"]) {
    assert.throws(() => validateClaimResponse({
      ok: true, task: { id, task_key: "audit_accessibility", event_code: "js_runtime", page_area: "other", occurrences },
    }));
  }
});

test("maps model results to fixed result codes only", () => {
  const patch = { finding_status: "issue_found", patch_available: true };
  assert.equal(chooseResultCode(patch, true, true, true, true), "model_completed");
  assert.equal(chooseResultCode(patch, true, false, true, true), "model_failed");
  assert.equal(chooseResultCode(patch, true, false, true, true), "model_failed");
  assert.equal(chooseResultCode(patch, true, true, false, true), "model_review");
  assert.equal(chooseResultCode(patch, true, true, true, true), "model_completed");
  assert.equal(chooseResultCode(patch, true, true, false, false), "model_failed");
  assert.equal(chooseResultCode({ finding_status: "no_issue", patch_available: false }, true, false), "model_no_patch");
  assert.equal(chooseResultCode({ finding_status: "no_issue", patch_available: false }), "model_no_patch");
  assert.equal(chooseResultCode({ finding_status: "blocked" }), "model_blocked");
  assert.equal(chooseResultCode(null), "model_failed");
  assert.equal(chooseResultCode({}, false), "model_failed");
  assert.equal(chooseResultCode({}, false, true, true, false, "timeout"), "model_timeout");
  assert.equal(chooseResultCode({}, false, true, true, false, "unknown"), "model_failed");
});

test("reads the persisted model summary before selecting a queue result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fam-agent-bridge-"));
  const summaryPath = join(directory, "summary.json");
  const expected = { finding_status: "needs_research", patch_available: false };

  try {
    await writeFile(summaryPath, JSON.stringify(expected), "utf8");
    const summary = await readTaskSummary(summaryPath);
    assert.deepEqual(summary, expected);
    assert.equal(chooseResultCode(summary, true), "model_no_patch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or malformed summaries map to a safe null result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fam-agent-bridge-invalid-"));
  const malformedPath = join(directory, "malformed.json");

  try {
    await writeFile(malformedPath, "{invalid json", "utf8");
    assert.equal(await readTaskSummary(""), null);
    assert.equal(await readTaskSummary(join(directory, "missing.json")), null);
    assert.equal(await readTaskSummary(malformedPath), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge request never logs or returns the supplied token", async () => {
  let captured;
  const data = await bridgeRequest({
    url: "https://example.invalid/functions/v1/fam-agent-coder-bridge",
    token: "secret-test-token",
    body: { action: "claim" },
    fetchImpl: async (_url, options) => {
      captured = options;
      return { ok: true, json: async () => ({ ok: true, task: null }) };
    },
  });
  assert.equal(data.task, null);
  assert.equal(captured.headers["x-fam-agent-token"], "secret-test-token");
  assert.equal(JSON.stringify(data).includes("secret-test-token"), false);
});

import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261111153059_fam_agent_coder_queue_bridge.sql", import.meta.url),
  "utf8",
);
const edgeSource = readFileSync(
  new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url),
  "utf8",
);
const reportMigration = readFileSync(
  new URL("../../supabase/migrations/20261113215335_fam_agent_report_snapshot_rpc.sql", import.meta.url),
  "utf8",
);
const bridgeSource = readFileSync(
  new URL("../../scripts/fam-agent-bridge.mjs", import.meta.url),
  "utf8",
);

test("model work decision skips empty/unconfigured queue and accepts claimed or manual work", () => {
  assert.equal(shouldRunModel(), false);
  assert.equal(shouldRunModel({ bridgeConfigured: false }), false);
  assert.equal(shouldRunModel({ bridgeConfigured: true, taskClaimed: false }), false);
  assert.equal(shouldRunModel({ manualTask: "audit a safe issue" }), true);
  assert.equal(shouldRunModel({ bridgeConfigured: true, taskClaimed: true }), true);
  assert.match(bridgeSource, /No queued coder task; skipping model download and inference/);
});

test("SQL bridge functions are invoker-only and restricted to service_role", () => {
  assert.match(migration, /security invoker/gi);
  assert.match(migration, /set search_path = ''/gi);
  assert.match(migration, /revoke all on function public\.claim_fam_agent_coder_tasks[^;]+from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.claim_fam_agent_coder_tasks[^;]+to service_role/i);
  assert.match(migration, /revoke all on function public\.finish_fam_agent_coder_task[^;]+from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.finish_fam_agent_coder_task[^;]+to service_role/i);
});

test("SQL claim returns only aggregate allowlisted fields", () => {
  const returned = migration.match(/returns table \(([\s\S]*?)\)\nlanguage plpgsql/i)?.[1] ?? "";
  assert.match(returned, /id uuid/i);
  assert.match(returned, /task_key text/i);
  assert.match(returned, /event_code text/i);
  assert.match(returned, /page_area text/i);
  assert.match(returned, /occurrences integer/i);
  assert.doesNotMatch(returned, /title|description|payload|email|user_id/i);
  assert.match(migration, /t\.approval_required = false/);
  assert.match(migration, /t\.source in \('system', 'scheduled_audit'\)/);
  assert.match(migration, /for update skip locked/i);
});

test("Edge Function exposes only fixed RPC names and rejects browser origins", () => {
  assert.match(edgeSource, /origin_not_allowed/);
  assert.match(edgeSource, /request_too_large/);
  assert.match(edgeSource, /claim_fam_agent_coder_tasks/);
  assert.match(edgeSource, /finish_fam_agent_coder_task_with_pr/);
  assert.match(edgeSource, /model_review/);
  assert.match(edgeSource, /model_completed.*model_review/);
  assert.doesNotMatch(edgeSource, /rpc\(body\./);
  assert.match(edgeSource, /sameSecret/);
  assert.match(edgeSource, /!EVENT_CODES\.has\(task\.event_code\)/);
  assert.match(edgeSource, /!PAGE_AREAS\.has\(task\.page_area\)/);
});


test("report bridge is read-only for snapshots and allows only bounded private report storage", () => {
  assert.ok(reportMigration.includes("security definer"));
  assert.ok(reportMigration.includes("set search_path = ''"));
  assert.ok(reportMigration.includes("revoke all on function public.get_fam_agent_report_snapshot() from public, anon, authenticated"));
  assert.ok(reportMigration.includes("grant execute on function public.get_fam_agent_report_snapshot() to service_role"));
  assert.ok(reportMigration.includes("grant execute on function public.save_fam_agent_system_report(date, jsonb) to service_role"));
  assert.ok(reportMigration.includes("pg_catalog.pg_column_size(p_report) > 65536"));
  assert.ok(reportMigration.includes("p_report ->> 'report_date' is distinct from"));
  assert.ok(reportMigration.includes("'public_site','limitations','markdown'"));
  assert.ok(reportMigration.includes("'queue_health_check','daily_report_digest'"));
  assert.ok(reportMigration.includes("'failed_tasks_24h', v_failed_tasks_24h"));
  assert.ok(reportMigration.includes("not (p_report ?& array["));
  assert.ok(reportMigration.includes("cron.job_run_details"));
  assert.ok(reportMigration.includes("private.fam_agent_tasks"));
  const snapshotFunction = reportMigration.split("create or replace function public.get_fam_agent_report_snapshot()")[1] ?? "";
  assert.doesNotMatch(snapshotFunction, /payload|description|result_summary|email|user_id/i);
  assert.ok(edgeSource.includes('body.action === "report"'));
  assert.ok(edgeSource.includes('body.action === "save_report"'));
  assert.ok(edgeSource.includes("save_fam_agent_system_report"));
  assert.ok(edgeSource.includes("const REPORT_FIELDS = new Set"));
  assert.ok(edgeSource.includes("MAX_BODY_BYTES = 65536"));
  assert.ok(edgeSource.includes(String.raw`/^\d{4}-\d{2}-\d{2}$/`));
});

test("rejects unrecognized telemetry enum values before building a model prompt", () => {
  for (const field of ["event_code", "page_area"]) {
    const task = {
      id,
      task_key: "audit_frontend_runtime",
      event_code: "js_runtime",
      page_area: "other",
      occurrences: 2,
    };
    task[field] = "untrusted arbitrary text";
    assert.throws(() => validateClaimResponse({ ok: true, task }));
  }
});
