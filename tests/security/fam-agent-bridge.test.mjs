import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_PROMPTS,
  validateClaimResponse,
  chooseResultCode,
  bridgeRequest,
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
  assert.equal(chooseResultCode({ finding_status: "issue_found", patch_available: true }), "model_completed");
  assert.equal(chooseResultCode({ finding_status: "no_issue", patch_available: false }), "model_no_patch");
  assert.equal(chooseResultCode({ finding_status: "blocked" }), "model_blocked");
  assert.equal(chooseResultCode(null), "model_failed");
  assert.equal(chooseResultCode({}, false), "model_failed");
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
  new URL("../../supabase/migrations/20261111170000_fam_agent_coder_queue_bridge.sql", import.meta.url),
  "utf8",
);
const edgeSource = readFileSync(
  new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url),
  "utf8",
);

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
  assert.match(edgeSource, /finish_fam_agent_coder_task/);
  assert.doesNotMatch(edgeSource, /rpc\(body\./);
  assert.match(edgeSource, /sameSecret/);
});
