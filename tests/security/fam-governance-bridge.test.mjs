import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateQueueHealthResponse,
  fetchQueueHealth,
  inspectQueueHealth,
  validateAgentMetricsResponse,
  fetchAgentMetrics,
} from "../../scripts/fam-governance-bridge.mjs";
import { makeReport, REPORT_MARKER } from "../../scripts/fam-agent-governance.mjs";

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
  assert.doesNotMatch(workflow, /gh pr merge/);
});
