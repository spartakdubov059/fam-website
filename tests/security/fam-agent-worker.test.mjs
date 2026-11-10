import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(
  new URL("../../supabase/functions/fam-agent-worker/index.ts", import.meta.url),
  "utf8",
);

test("worker uses a dedicated server-side token and rejects missing credentials", () => {
  assert.match(worker, /Deno\.env\.get\(["']FAM_AGENT_WORKER_TOKEN["']\)/);
  assert.match(worker, /x-fam-agent-token/);
  assert.match(worker, /sameSecret\(suppliedToken, WORKER_TOKEN\)/);
  assert.match(worker, /error: "unauthorized"/);
});

test("worker processes only the three explicitly allowlisted no-approval task types", () => {
  assert.match(worker, /const queueHealthTask = task\?\.agent_key === "quality"/);
  assert.match(worker, /task\?\.task_type === "queue_health_check"/);

  assert.match(worker, /const dailyReportTask = task\?\.agent_key === "orchestrator"/);
  assert.match(worker, /task\?\.task_type === "daily_report_digest"/);

  assert.match(worker, /const systemHealthTask = task\?\.agent_key === "technical"/);
  assert.match(worker, /task\?\.task_type === "system_health_check"/);
  assert.match(worker, /task\?\.approval_required === false/);

  assert.match(worker, /const safeTask = queueHealthTask \|\| dailyReportTask \|\| systemHealthTask/);
  assert.match(worker, /let status: "completed" \| "blocked" = "blocked"/);
  assert.match(worker, /Задача остановлена: её тип не входит в разрешённый список безопасного исполнителя/);
});

test("approved tasks use only fixed, server-side aggregate RPCs", () => {
  assert.match(worker, /rpc\(["']get_fam_agent_queue_health["']/);
  assert.match(worker, /rpc\(["']get_fam_agent_task_daily_digest["']/);
  assert.match(worker, /rpc\(["']get_fam_agent_task_system_health["']/);

  assert.doesNotMatch(worker, /task\??\.payload/);
  assert.doesNotMatch(worker, /\.payload\b/);
  assert.doesNotMatch(worker, /\.from\(\s*["'](?:messages|profiles|listings)["']\s*\)/i);
  assert.doesNotMatch(worker, /\/rest\/v1\/(?:messages|profiles|listings)\b/i);
  assert.doesNotMatch(worker, /\b(?:from|join)\s+(?:public\.)?(?:messages|profiles|listings)\b/i);
  assert.match(worker, /rpc\("get_fam_agent_task_daily_digest"/);
  assert.match(worker, /rpc\("get_fam_agent_task_system_health"/);
  assert.doesNotMatch(worker, /\.delete\s*\(|\.update\s*\(|auth\.admin|storage\.from/);
});

test("worker caps batch size and uses bounded task leases", () => {
  assert.match(worker, /Math\.min\(5, Math\.max\(1, body\.limit\)\)/);
  assert.match(worker, /p_lease_seconds: 120/);
  assert.match(worker, /p_limit: limit/);
});

test("worker accepts POST only and rejects browser-origin requests", () => {
  assert.match(worker, /req\.method !== "POST"/);
  assert.match(worker, /req\.headers\.get\("origin"\)/);
});
