import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(
  new URL("../../supabase/functions/fam-agent-worker/index.ts", import.meta.url),
  "utf8",
);

test("worker uses a dedicated server-side token and rejects missing credentials", () => {
  assert.match(worker, /Deno\\.env\\.get\\(["\']FAM_AGENT_WORKER_TOKEN["\']\\)/);
  assert.match(worker, /x-fam-agent-token/);
  assert.match(worker, /sameSecret\\(suppliedToken, WORKER_TOKEN\\)/);
  assert.match(worker, /error: "unauthorized"/);
});

test("worker processes only the explicitly permitted no-approval quality check", () => {
  assert.match(worker, /task\\?\\.agent_key === "quality"/);
  assert.match(worker, /task\\?\\.task_type === "queue_health_check"/);
  assert.match(worker, /task\\?\\.approval_required === false/);
  assert.match(worker, /"Задача остановлена: её тип не входит в разрешённый список безопасного исполнителя\\."/);
});

test("worker reads aggregate queue metrics for its approved health check only", () => {
  assert.match(worker, /rpc\\("get_fam_agent_queue_health", \\{\\}\\)/);
  assert.match(worker, /failed_last_24h/);
  assert.match(worker, /expired_leases/);
  assert.match(worker, /Содержимое задач и личные данные не читались/);
  assert.doesNotMatch(worker, /\\.payload|messages|profiles|listings/);
});

test("worker caps batch size and uses bounded task leases", () => {
  assert.match(worker, /Math\\.min\\(5, Math\\.max\\(1, body\\.limit\\)\\)/);
  assert.match(worker, /p_lease_seconds: 120/);
  assert.match(worker, /p_limit: limit/);
});

test("worker accepts POST only and rejects browser-origin requests", () => {
  assert.match(worker, /req\\.method !== "POST"/);
  assert.match(worker, /req\\.headers\\.get\\("origin"\\)/);
});
