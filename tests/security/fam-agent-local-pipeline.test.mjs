import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildIndependentReview } from "../../scripts/fam-agent-reviewer.mjs";
import { buildSecurityReport } from "../../scripts/fam-agent-security.mjs";
import { buildPerformanceReport } from "../../scripts/fam-agent-performance.mjs";
import { validateAgentPatch } from "../../scripts/validate-local-agent-patch.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const taskId = "123e4567-e89b-42d3-a456-426614174000";
const syntheticPrUrl = "https://github.com/spartakdubov059/fam-website/pull/123";
const executeFile = promisify(execFile);
const workflow = readFileSync(new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url), "utf8");

async function run(command, args, options = {}) {
  const result = await executeFile(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return result.stdout;
}

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

function workflowStepScript(marker) {
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${marker}`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  const section = workflow.slice(start, next < 0 ? undefined : next);
  const block = section.match(/^        run: \|\n((?:          .*\n)+)/m)?.[1];
  assert.ok(block, `Missing shell script in workflow step: ${marker}`);
  return block.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Synthetic request exceeded the test limit.");
  }
  return JSON.parse(body);
}

test("synthetic queue task flows through local model, real patch, trusted QA, reviewers and finish bridge", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "fam-agent-local-pipeline-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  let modelCalls = 0;
  const bridgeCalls = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/bridge") {
        const body = await readJson(request);
        bridgeCalls.push(body);
        if (body.action === "claim") {
          return sendJson(response, {
            ok: true,
            task: {
              id: taskId,
              task_key: "audit_frontend_runtime",
              event_code: "js_runtime",
              page_area: "other",
              occurrences: 2,
              event_summary: "Ошибка выполнения JavaScript",
              observed_hour: "2026-11-14T12:00:00Z",
              previous_attempts: 0,
            },
          });
        }
        if (body.action === "finish") return sendJson(response, { ok: true, saved: true });
        return sendJson(response, { ok: false }, 400);
      }

      if (request.url === "/v1/chat/completions") {
        const body = await readJson(request);
        modelCalls += 1;
        const userMessage = body.messages.at(-1)?.content || "";
        const answer = userMessage.includes("source_context")
          ? {
              finding_status: "issue_found",
              problem_summary: "Synthetic fixture title is incorrect.",
              root_cause: "The fixture contains an incorrect title.",
              evidence: ["index.html contains <title>FAM fixture broken</title>"],
              edits: [{
                path: "index.html",
                find: "<title>FAM fixture broken</title>",
                replace: "<title>FAM fixture fixed</title>",
              }],
              summary: "Corrected the synthetic fixture title.",
              proposed_change: "Replace the incorrect fixture title.",
              risk: "low",
              requires_approval: false,
              tests: ["Run the synthetic fixture regression test."],
            }
          : {
              finding_status: "issue_found",
              problem_summary: "Synthetic fixture has an incorrect page title.",
              root_cause: "The tracked fixture title is intentionally wrong.",
              evidence: ["index.html contains <title>FAM fixture broken</title>"],
              files: ["index.html"],
              keywords: ["title"],
              plan: "Correct only the synthetic fixture title and run its regression test.",
            };
        return sendJson(response, { choices: [{ message: { content: JSON.stringify(answer) } }] });
      }

      return sendJson(response, { error: "unexpected synthetic endpoint" }, 404);
    } catch (error) {
      return sendJson(response, { error: error.message }, 500);
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;

  const fixture = join(work, "generator");
  const runnerTemp = join(work, "runner-temp");
  const githubEnv = join(work, "github-env");
  const githubOutput = join(work, "github-output");
  mkdirSync(join(fixture, ".github", "prompts"), { recursive: true });
  mkdirSync(join(fixture, "tests", "fixtures"), { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(join(fixture, ".github", "prompts", "fam-codex-developer.md"),
    readFileSync(join(repoRoot, ".github", "prompts", "fam-codex-developer.md"), "utf8"));
  writeFileSync(join(fixture, "index.html"), "<!doctype html>\n<title>FAM fixture broken</title>\n");
  writeFileSync(join(fixture, "tests", "fixtures", "fam-agent-pipeline-regression.test.mjs"),
    readFileSync(new URL("../fixtures/fam-agent-pipeline-regression.test.mjs", import.meta.url), "utf8"));
  for (const script of ["render-fam-agent-report.mjs", "fam-agent-report.mjs"]) {
    writeFileSync(join(fixture, "scripts", script), readFileSync(join(repoRoot, "scripts", script), "utf8"));
  }
  await git(fixture, "init", "--quiet");
  await git(fixture, "config", "user.name", "FAM synthetic test");
  await git(fixture, "config", "user.email", "fam-synthetic@example.invalid");
  await git(fixture, "add", ".");
  await git(fixture, "commit", "--quiet", "-m", "synthetic base");
  const baseSha = (await git(fixture, "rev-parse", "HEAD")).trim();
  const remote = join(work, "synthetic-origin.git");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await git(fixture, "remote", "add", "origin", remote);
  await git(fixture, "push", "--quiet", "origin", "HEAD:main");

  const env = {
    ...process.env,
    FAM_AGENT_BRIDGE_URL: localBaseUrl + "/bridge",
    FAM_AGENT_WORKER_TOKEN: "synthetic-only-token",
    GITHUB_ENV: githubEnv,
    GITHUB_OUTPUT: githubOutput,
  };
  await run(process.execPath, [join(repoRoot, "scripts", "fam-agent-bridge.mjs"), "claim"], {
    cwd: fixture,
    env,
  });
  const claimOutput = readFileSync(githubOutput, "utf8");
  assert.match(claimOutput, /claimed=true/);
  assert.match(claimOutput, /run_model=true/);
  const taskEnvironment = readFileSync(githubEnv, "utf8");
  assert.match(taskEnvironment, new RegExp("FAM_CODER_TASK_ID=" + taskId));
  const task = taskEnvironment.match(/^FAM_TASK=(.*)$/m)?.[1];
  assert.ok(task, "The claimed allowlisted task must be passed to the coder runner.");

  await run(process.execPath, [join(repoRoot, "scripts", "run-local-coder.mjs")], {
    cwd: fixture,
    env: {
      ...env,
      FAM_TASK: task,
      FAM_MODEL_API_URL: localBaseUrl + "/v1/chat/completions",
      FAM_MODEL_ID: "synthetic-local-model",
      GITHUB_WORKSPACE: fixture,
      RUNNER_TEMP: runnerTemp,
    },
  });

  const artifactDir = join(runnerTemp, "fam-agent");
  const patchPath = join(artifactDir, "fam-agent.patch");
  const summaryPath = join(artifactDir, "summary.json");
  const patch = readFileSync(patchPath, "utf8");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(modelCalls, 2, "The model stub must cover planning and exact-edit generation.");
  assert.equal(readFileSync(join(artifactDir, "base.sha"), "utf8").trim(), baseSha);
  assert.deepEqual(validateAgentPatch(patch, summary), {
    paths: ["index.html"],
    requires_approval: true,
  });

  const qa = join(work, "trusted-qa");
  await git(work, "clone", "--quiet", fixture, qa);
  const regressionPath = "tests/fixtures/fam-agent-pipeline-regression.test.mjs";
  await assert.rejects(() => run(process.execPath, [regressionPath], { cwd: qa }));
  await run("git", ["apply", patchPath], { cwd: qa });
  await run(process.execPath, [regressionPath], { cwd: qa });

  const badQa = join(work, "bad-qa");
  await git(work, "clone", "--quiet", fixture, badQa);
  const ineffectivePatch = patch.replace(
    "+<title>FAM fixture fixed</title>",
    "+<title>FAM fixture still broken</title>",
  );
  assert.notEqual(ineffectivePatch, patch, "The negative control must alter the generated patch.");
  const ineffectivePatchPath = join(work, "ineffective.patch");
  writeFileSync(ineffectivePatchPath, ineffectivePatch);
  await run("git", ["apply", ineffectivePatchPath], { cwd: badQa });
  await assert.rejects(() => run(process.execPath, [regressionPath], { cwd: badQa }));

  const validation = validateAgentPatch(patch, summary);
  const safety = {
    ...buildSecurityReport(patch),
    paths: validation.paths,
    requires_approval: validation.requires_approval,
  };
  const performance = buildPerformanceReport(patch);
  assert.equal(safety.conclusion, "no_static_finding");
  assert.equal(safety.manual_approval_required, true);
  assert.equal(performance.conclusion, "no_static_hotspot");
  const review = buildIndependentReview({
    patch,
    summary,
    safety,
    baseSha,
    currentSha: (await git(qa, "rev-parse", "HEAD")).trim(),
    qaStatus: "passed",
  });
  assert.equal(review.conclusion, "pass_for_draft_pr");
  assert.equal(review.semantic_correctness, "not_independently_assessed");

  const reviewDir = join(runnerTemp, "fam-agent-review");
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, "review.md"), "Synthetic independent review passed.\n");
  writeFileSync(join(reviewDir, "security.md"), "No static security finding.\n");
  writeFileSync(join(reviewDir, "performance.md"), "No static performance hotspot.\n");
  writeFileSync(join(reviewDir, "review.json"), JSON.stringify(review));
  writeFileSync(join(reviewDir, "security.json"), JSON.stringify(safety));
  writeFileSync(join(reviewDir, "performance.json"), JSON.stringify(performance));
  const prBodyPath = join(work, "pr-body.md");
  const stepSummaryPath = join(work, "step-summary.md");
  const shimDir = join(work, "bin");
  mkdirSync(shimDir);
  const ghShim = join(shimDir, "gh");
  writeFileSync(ghShim, `#!/bin/bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$FAM_GITHUB_CALLS"\nif [[ "$1 $2" == "pr create" ]]; then\n  body_file=''\n  while (($#)); do\n    if [[ "$1" == '--body-file' ]]; then shift; body_file="$1"; break; fi\n    shift\n  done\n  test -s "$body_file"\n  cp "$body_file" "$FAM_CAPTURED_PR_BODY"\n  echo '${syntheticPrUrl}'\nelif [[ "$1 $2" == "pr checks" ]]; then\n  echo '[{"name":"Russian content safety tests","state":"SUCCESS","bucket":"pass"}]'\nelif [[ "$1 $2" == "pr comment" ]]; then\n  exit 0\nelse\n  exit 91\nfi\n`, { mode: 0o755 });
  const gitShim = join(shimDir, "git");
  writeFileSync(gitShim, "#!/bin/bash\nset -euo pipefail\nif [[ \"${1:-} ${2:-}\" == 'remote set-url' ]]; then exec /usr/bin/git remote set-url origin \"$FAM_SYNTHETIC_REMOTE\"; fi\nexec /usr/bin/git \"$@\"\n", { mode: 0o755 });
  const prEnv = {
    ...process.env,
    PATH: shimDir + ":" + process.env.PATH,
    GH_TOKEN: "synthetic-only-token",
    FAM_PR_TOKEN_MODE: "github-token",
    FAM_SYNTHETIC_REMOTE: remote,
    FAM_GITHUB_CALLS: join(work, "github-calls.log"),
    FAM_CAPTURED_PR_BODY: prBodyPath,
    GITHUB_RUN_ID: "synthetic-run-123",
    GITHUB_REPOSITORY: "spartakdubov059/fam-website",
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: join(work, "pr-output.txt"),
    GITHUB_STEP_SUMMARY: stepSummaryPath,
  };
  await run("/bin/bash", ["--noprofile", "--norc", "-e", "-c", workflowStepScript("id: pr\n        env:")], { cwd: fixture, env: prEnv });
  const createdPrBody = readFileSync(prBodyPath, "utf8");
  assert.match(createdPrBody, /Любое объединение PR и публикация требуют отдельного явного разрешения владельца/);
  assert.match(createdPrBody, /Production этим workflow не изменяется/);
  const prOutput = readFileSync(join(work, "pr-output.txt"), "utf8");
  assert.ok(prOutput.includes("pr_url=" + syntheticPrUrl));
  const createdCommitSha = prOutput.match(/^commit_sha=([0-9a-f]{40})$/m)?.[1];
  assert.ok(createdCommitSha, "The PR manager must report the actual synthetic commit SHA.");
  assert.match(readFileSync(join(work, "github-calls.log"), "utf8"), /pr create --draft --base main/);
  const pushed = await run("git", ["--git-dir", remote, "show", "refs/heads/codex/fam-run-synthetic-run-123:index.html"]);
  assert.match(pushed, /FAM fixture fixed/);
  assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/codex/fam-run-synthetic-run-123"])).trim(), createdCommitSha);
  const checkEnv = { ...prEnv, PR_URL: syntheticPrUrl };
  await run("/bin/bash", ["--noprofile", "--norc", "-e", "-c", workflowStepScript("Дождаться независимых проверок PR")], { cwd: fixture, env: checkEnv });
  assert.match(readFileSync(join(work, "github-calls.log"), "utf8"), /pr checks .*--required/);
  assert.match(readFileSync(join(work, "github-calls.log"), "utf8"), /pr comment/);

  await run(process.execPath, [join(repoRoot, "scripts", "fam-agent-bridge.mjs"), "finish"], {
    cwd: fixture,
    env: {
      ...env,
      FAM_CODER_TASK_ID: taskId,
      FAM_SUMMARY_PATH: summaryPath,
      FAM_AGENT_PR_URL: syntheticPrUrl,
      FAM_AGENT_COMMIT_SHA: createdCommitSha,
      FAM_MODEL_STEP_OUTCOME: "success",
      FAM_QA_OUTCOME: "success",
      FAM_PR_MANAGER_OUTCOME: "success",
    },
  });
  const finish = bridgeCalls.find((call) => call.action === "finish");
  assert.deepEqual(finish, {
    action: "finish",
    task_id: taskId,
    result_code: "model_completed",
    pr_url: syntheticPrUrl,
    commit_sha: createdCommitSha,
  });
  assert.deepEqual(bridgeCalls.map((call) => call.action), ["claim", "finish"]);
});
