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
