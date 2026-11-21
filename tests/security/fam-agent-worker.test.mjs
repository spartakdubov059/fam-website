import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finishTaskAndCount } from "../../supabase/functions/fam-agent-worker/finish-task.mjs";

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

test("worker processes only the four explicitly allowlisted no-approval task types", () => {
  assert.match(worker, /const queueHealthTask = task\?\.agent_key === "quality"/);
  assert.match(worker, /task\?\.task_type === "queue_health_check"/);
  assert.match(worker, /task\?\.approval_required === false/);

  assert.match(worker, /const dailyReportTask = task\?\.agent_key === "orchestrator"/);
  assert.match(worker, /task\?\.task_type === "daily_report_digest"/);

  assert.match(worker, /const systemHealthTask = task\?\.agent_key === "technical"/);
  assert.match(worker, /task\?\.task_type === "system_health_check"/);

  assert.match(worker, /const siteErrorTask = task\?\.agent_key === "technical"/);
  assert.match(worker, /task\?\.task_type === "site_error_digest"/);

  assert.match(
    worker,
    /const safeTask = queueHealthTask \|\| dailyReportTask \|\| systemHealthTask \|\| siteErrorTask;/,
  );
  assert.match(worker, /let status: "completed" \| "blocked" = "blocked"/);
  assert.match(worker, /Задача остановлена: её тип не входит в разрешённый список безопасного исполнителя/);
});

test("approved tasks use only fixed, server-side aggregate RPCs", () => {
  assert.match(worker, /rpc\(["']get_fam_agent_queue_health["']/);
  assert.match(worker, /rpc\(["']get_fam_agent_task_daily_digest["']/);
  assert.match(worker, /rpc\(["']get_fam_agent_task_system_health["']/);
  assert.match(worker, /rpc\(["']get_fam_agent_task_site_error_digest["']/);

  assert.doesNotMatch(worker, /task\??\.payload/);
  assert.doesNotMatch(worker, /\.from\(["'](?:messages|profiles|listings|auth\.users)["']\)/i);
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

test("worker reports failure if the task result was not saved", () => {
  assert.match(worker, /import \{ finishTaskAndCount \} from "\.\/finish-task\.mjs"/);
  assert.match(worker, /const savedStatus = await finishTaskAndCount\(rpc, \{/);
  assert.match(worker, /if \(savedStatus === "completed"\) completed\+\+;\s*else blocked\+\+;/);
});

test("finish result is counted only after the finish RPC confirms persistence", async () => {
  const calls = [];
  const result = await finishTaskAndCount(async (...args) => {
    calls.push(args);
    return true;
  }, {
    taskId: "task-id",
    workerId: "fam-agent-worker-v1",
    status: "completed",
    summary: "safe aggregate summary",
  });

  assert.equal(result, "completed");
  assert.deepEqual(calls, [["finish_fam_agent_task", {
    p_task_id: "task-id",
    p_worker_id: "fam-agent-worker-v1",
    p_status: "completed",
    p_summary: "safe aggregate summary",
  }]]);
});

test("false finish RPC response fails closed instead of reporting completion", async () => {
  for (const response of [false, null, undefined, { ok: true }]) {
    await assert.rejects(
      finishTaskAndCount(async () => response, {
        taskId: "task-id",
        workerId: "fam-agent-worker-v1",
        status: "completed",
        summary: "safe aggregate summary",
      }),
      /task_finish_not_saved/,
    );
  }
});
