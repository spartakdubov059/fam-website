import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workflow = await readFile(new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url), "utf8");
const finishStart = workflow.indexOf("\n  finish_task:\n");
assert.notEqual(finishStart, -1, "The queue finalization job must exist.");
const afterFinish = workflow.slice(finishStart + 1);
const nextJob = afterFinish.slice(1).search(/^  [a-zA-Z_][\w-]*:\s*$/m);
const finishJob = nextJob < 0 ? afterFinish : afterFinish.slice(0, nextJob + 1);
const steps = finishJob.split(/^      - name: /m).slice(1);
const taskId = "123e4567-e89b-42d3-a456-426614174000";
const prUrl = "https://github.com/spartakdubov059/fam-website/pull/123";
const commitSha = "a".repeat(40);

function interpolate(value, context) {
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    assert.ok(Object.hasOwn(context, expression), `Unsupported workflow expression: ${expression}`);
    return context[expression];
  });
}

// This fixture models checkout/artifact file availability, not the Actions service.
// The command and environment come from the real finalization job, and the real
// bridge CLI sends its result to an HTTP server bound only to loopback.
async function runFreshFinish(selectedSteps, outcomes = {}) {
  const root = await mkdtemp(join(tmpdir(), "fam-finish-runner-"));
  const workspace = join(root, "workspace");
  const runnerTemp = join(root, "runner-temp");
  await mkdir(workspace);
  await mkdir(runnerTemp);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      token: request.headers["x-fam-agent-token"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, saved: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const context = {
    "secrets.FAM_AGENT_BRIDGE_URL": `http://127.0.0.1:${server.address().port}/finish`,
    "secrets.FAM_AGENT_WORKER_TOKEN": "synthetic-local-token",
    "needs.generate.outputs.task_id": taskId,
    "needs.generate.outputs.model_outcome": "success",
    "needs.verify.result": "success",
    "needs.prepare_review.result": "success",
    "needs.prepare_review.outputs.pr_url": prUrl,
    "needs.prepare_review.outputs.commit_sha": commitSha,
    "runner.temp": runnerTemp,
    ...outcomes,
  };
  let execution;
  try {
    for (const step of selectedSteps) {
      if (/uses: actions\/checkout@/.test(step)) {
        assert.match(step, /ref: \$\{\{ github\.sha \}\}/);
        assert.match(step, /persist-credentials: false/);
        await mkdir(join(workspace, "scripts"));
        await copyFile(new URL("../../scripts/fam-agent-bridge.mjs", import.meta.url), join(workspace, "scripts/fam-agent-bridge.mjs"));
      } else if (/uses: actions\/setup-node@/.test(step)) {
        assert.match(step, /node-version: ["']?22["']?\s*$/m);
      } else if (/uses: actions\/download-artifact@/.test(step)) {
        assert.match(step, /if: needs\.generate\.outputs\.model_outcome == 'success'/);
        if (context["needs.generate.outputs.model_outcome"] !== "success") continue;
        assert.match(step, /name: fam-local-agent-result/);
        const artifactPath = interpolate(step.match(/^          path: (.+)$/m)?.[1] ?? "", context);
        assert.ok(artifactPath.startsWith(runnerTemp + "/"));
        await mkdir(artifactPath, { recursive: true });
        await writeFile(join(artifactPath, "summary.json"), JSON.stringify({ finding_status: "issue_found", patch_available: true }));
      } else {
        const command = step.match(/^        run: (.+)$/m)?.[1];
        assert.ok(command, "Every additional finish step needs explicit fixture support.");
        const environment = Object.fromEntries([...step.matchAll(/^          ([A-Z][A-Z0-9_]*): (.+)$/gm)]
          .map(([, key, value]) => [key, interpolate(value, context)]));
        try {
          const result = await execute("/bin/bash", ["--noprofile", "--norc", "-e", "-c", command], {
            cwd: workspace,
            env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...environment },
            timeout: 10000,
          });
          execution = { code: 0, ...result };
        } catch (error) {
          execution = { code: error.code, stdout: error.stdout, stderr: error.stderr };
        }
      }
    }
    assert.ok(execution, "The finish command must actually execute.");
    return { execution, requests };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test("queue finalization checks out its trusted workflow revision before executing the bridge", () => {
  const checkoutIndex = steps.findIndex((step) => /uses: actions\/checkout@/.test(step));
  const setupIndex = steps.findIndex((step) => /uses: actions\/setup-node@/.test(step));
  const finishIndex = steps.findIndex((step) => /run: node scripts\/fam-agent-bridge\.mjs finish/.test(step));
  assert.ok(checkoutIndex >= 0 && checkoutIndex < finishIndex, "A fresh runner needs the bridge script before it can finalize a task.");
  assert.ok(setupIndex >= 0 && setupIndex < finishIndex, "The bridge must run with the declared Node version.");
  assert.match(steps[checkoutIndex], /ref: \$\{\{ github\.sha \}\}/);
  assert.match(steps[checkoutIndex], /persist-credentials: false/);
  assert.match(steps[setupIndex], /node-version: ["']?22["']?\s*$/m);
});

for (const scenario of [
  { name: "completed patch", outcomes: {}, expected: "model_completed", metadata: true },
  { name: "created PR awaiting review", outcomes: { "needs.prepare_review.result": "failure" }, expected: "model_review", metadata: true },
  { name: "failed QA", outcomes: { "needs.verify.result": "failure", "needs.prepare_review.result": "skipped" }, expected: "model_failed", metadata: false },
  { name: "failed inference without a summary artifact", outcomes: { "needs.generate.outputs.model_outcome": "failure", "needs.verify.result": "skipped", "needs.prepare_review.result": "skipped" }, expected: "model_failed", metadata: false },
]) {
  test(`fresh finish runner persists ${scenario.name} through the real bridge CLI`, async () => {
    const { execution, requests } = await runFreshFinish(steps, scenario.outcomes);
    assert.equal(execution.code, 0, execution.stderr);
    assert.deepEqual(requests, [{
      method: "POST",
      token: "synthetic-local-token",
      body: {
        action: "finish",
        task_id: taskId,
        result_code: scenario.expected,
        pr_url: scenario.metadata ? prUrl : null,
        commit_sha: scenario.metadata ? commitSha : null,
      },
    }]);
    assert.ok(!execution.stdout.includes("synthetic-local-token"));
  });
}

test("negative control: omitting checkout reproduces the missing bridge failure and sends no result", async () => {
  const withoutCheckout = steps.filter((step) => !/uses: actions\/checkout@/.test(step));
  const { execution, requests } = await runFreshFinish(withoutCheckout);
  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /Cannot find module.*fam-agent-bridge\.mjs/);
  assert.deepEqual(requests, []);
});
