import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(
  new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url),
  "utf8",
);
const testWorkflow = readFileSync(
  new URL("../../.github/workflows/moderation-regression.yml", import.meta.url),
  "utf8",
);
const prompt = readFileSync(
  new URL("../../.github/prompts/fam-codex-developer.md", import.meta.url),
  "utf8",
);
const runner = readFileSync(
  new URL("../../scripts/run-local-coder.mjs", import.meta.url),
  "utf8",
);
const validator = readFileSync(
  new URL("../../scripts/validate-local-agent-patch.mjs", import.meta.url),
  "utf8",
);
const agentReport = readFileSync(
  new URL("../../scripts/fam-agent-report.mjs", import.meta.url),
  "utf8",
);
const reportRenderer = readFileSync(
  new URL("../../scripts/render-fam-agent-report.mjs", import.meta.url),
  "utf8",
);

const integrationTrialWorkflow = readFileSync(
  new URL("../../.github/workflows/fam-qwen38-pr126-general-planner.yml", import.meta.url),
  "utf8",
);
const timeAgoScopeValidator = readFileSync(
  new URL("../../scripts/validate-local-agent-time-ago.mjs", import.meta.url),
  "utf8",
);

const noPatchValidator = readFileSync(
  new URL("../../scripts/validate-local-agent-no-patch.mjs", import.meta.url),
  "utf8",
);

test("local FAM coding agent permits the owner and trusted inspector dispatch", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.ok(workflow.includes("branches: [main]"));
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron: ["']15 3 \* \* \*["']/);
  assert.match(workflow, /github\.actor == 'spartakdubov059'/);
  assert.match(workflow, /github\.actor == 'github-actions\[bot\]'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});

test("agent uses local open weights and never needs a paid API key", () => {
  assert.match(workflow, /sammyblues\/Qwen3\.8-27B-IQ2_XS-GGUF\/resolve\/0466a972ecb7e0711efd814b6f2e3856b4b4027b/);
  assert.match(workflow, /eaeb705c72e5b7a55268f9f9a84b855ec3c1dd1b1f8c414cfc2d9ea52ad9eb23/);
  assert.match(workflow, /FAM_MODEL_ID: Qwen3\.8-27B-IQ2_XS/);
  assert.match(workflow, /--reasoning off/);
  assert.match(workflow, /ggml-org\/llama\.cpp/);
  assert.match(workflow, /127\.0\.0\.1:8080/);
  assert.match(runner, /127\.0\.0\.1:8080\/v1\/chat\/completions/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|openai-api-key|openai\/codex-action/i);
  assert.doesNotMatch(runner, /api\.openai\.com|OPENAI_API_KEY/);
});

test("llama.cpp server builds without unnecessary web UI assets", () => {
  // The pinned upstream llama.cpp defaults LLAMA_USE_PREBUILT_UI=ON; missing
  // Workbox files in its downloaded UI archive previously broke the build.
  assert.match(workflow, /-DLLAMA_BUILD_UI=OFF/);
  assert.match(workflow, /-DLLAMA_USE_PREBUILT_UI=OFF/);
  assert.match(workflow, /cmake --build "\$RUNNER_TEMP\/llama\.cpp\/build" --config Release --target llama-server/);
});

test("inference runs under an isolated uid and receives no bridge credentials", () => {
  const inferenceStep = workflow.match(/- name: Запустить локальную модель и подготовить patch[\s\S]*?(?=\n      - name:)/)?.[0] ?? "";
  assert.ok(inferenceStep, "model execution step must be present");
  assert.match(inferenceStep, /useradd --system[^\n]*fam-inference/);
  assert.match(inferenceStep, /sudo -u fam-inference env -i/);
  assert.match(inferenceStep, /INFERENCE_HOME="\/tmp\/fam-inference-home"/);
  assert.doesNotMatch(inferenceStep, /INFERENCE_HOME="\$RUNNER_TEMP\//);
  assert.match(inferenceStep, /sudo install -d -o fam-inference -g fam-inference -m 700 "\$INFERENCE_HOME"/);
  assert.match(inferenceStep, /sudo install -o fam-inference -g fam-inference -m 500 "\$SERVER" "\$INFERENCE_SERVER"/);
  assert.match(inferenceStep, /ldd "\$SERVER" \| awk/);
  assert.match(inferenceStep, /sudo install -o fam-inference -g fam-inference -m 400 "\$library" "\$INFERENCE_HOME\/\$\(basename "\$library"\)"/);
  assert.match(inferenceStep, /LD_LIBRARY_PATH="\$INFERENCE_HOME"/);
  assert.match(inferenceStep, /sudo chmod 644 "\$MODEL"/);
  assert.match(inferenceStep, /sudo ln "\$MODEL" "\$INFERENCE_MODEL"/);
  assert.match(inferenceStep, /PATH="\/usr\/bin:\/bin" HOME="\$INFERENCE_HOME" TMPDIR="\$INFERENCE_HOME"/);
  assert.match(inferenceStep, /"\$INFERENCE_SERVER" -m "\$INFERENCE_MODEL"/);
  assert.doesNotMatch(inferenceStep, /chown[^\n]*\$MODEL|chmod (?!644 )[^\n]*\$MODEL/);
  assert.doesNotMatch(inferenceStep, /pushd "\$INFERENCE_HOME"|popd/);
  assert.match(inferenceStep, /env -i[\s\S]*?GITHUB_WORKSPACE="\$GITHUB_WORKSPACE"[\s\S]*?FAM_MODEL_ID=/);
  const controllerLaunch = inferenceStep.match(/env -i[\s\S]*?node scripts\/run-local-coder\.mjs/)?.[0] ?? "";
  assert.ok(controllerLaunch, "model controller must launch through an environment allowlist");
  assert.doesNotMatch(controllerLaunch, /FAM_AGENT_WORKER_TOKEN|FAM_AGENT_BRIDGE_URL|FAM_CODER_TASK_ID/);
  assert.match(inferenceStep, /node scripts\/fam-agent-bridge\.mjs heartbeat/);
  assert.match(inferenceStep, /kill "\$SERVER_PID"/);
});

test("model receives read-only repository access and can only propose allowlisted paths", () => {
  assert.match(workflow, /generate:[\s\S]*?permissions:\n\s+contents: read/);
  assert.match(workflow, /index\.html\|css\/\*\|js\/\*\|assets\/\*\|docs\/\*\|tests\/\*/);
  assert.match(validator, /export function isAllowedAgentPath/);
  assert.match(prompt, /Не меняй файлы \.github\/\*\*, scripts\/\*\*, supabase\/\*\*/);
  assert.match(prompt, /Не запускай shell-команды/);
  assert.match(prompt, /персональные данные/);
});

test("coder records findings and exposes no-patch outcomes in the workflow summary", () => {
  assert.match(runner, /finding_status/);
  assert.match(runner, /problem_summary/);
  assert.match(runner, /root_cause/);
  assert.match(runner, /evidence/);
  assert.match(runner, /proposed_change/);
  assert.match(agentReport, /verification_status/);
  assert.match(agentReport, /not_run_no_patch/);
  assert.match(reportRenderer, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /Показать структурированный результат модели/);
  assert.match(workflow, /steps\.agent\.outcome == 'success'/);
  assert.match(workflow, /verified-report\.md/);
  assert.match(workflow, /verified-report\.md" \\\n\s+passed/);
  assert.match(reportRenderer, /Only a verified patch may be marked as passed/);
});

test("independent verification runs without model or write credentials", () => {
  assert.match(workflow, /verify:\n[\s\S]*?permissions:\n\s+contents: read/);
  assert.match(workflow, /node --test tests\/moderation\/\*\.test\.mjs tests\/security\/\*\.test\.mjs/);
  assert.match(workflow, /node --check \/tmp\/fam-inline-scripts\.js/);
  assert.match(workflow, /git diff --check HEAD/);
  assert.match(workflow, /has_behavior_code=false/);
  assert.match(workflow, /Изменение HTML\/JavaScript не содержит регрессионного теста/);
  assert.match(workflow, /node --check scripts\/run-local-coder\.mjs/);
  assert.match(workflow, /node --check scripts\/validate-local-agent-patch\.mjs/);
});

test("the test workflow can be explicitly dispatched for a token-created PR branch", () => {
  assert.match(testWorkflow, /workflow_dispatch:/);
  assert.match(workflow, /gh workflow run \.github\/workflows\/moderation-regression\.yml --ref "\$BRANCH"/);
  assert.match(workflow, /BRANCH="codex\/fam-run-\$\{GITHUB_RUN_ID\}"[\s\S]*?gh workflow run \.github\/workflows\/moderation-regression\.yml --ref "\$BRANCH"/);
  assert.match(workflow, /gh run watch "\$TEST_RUN_ID" --exit-status --interval 10/);
});

test("all changes require owner approval before merge and production publication", () => {
  assert.match(validator, /CRITICAL_CHANGE_PATTERNS/);
  assert.match(validator, /export function requiresManualApproval/);
  assert.match(workflow, /gh pr create --draft/);
  assert.match(workflow, /отдельного явного разрешения владельца/);
  assert.equal(workflow.includes("gh pr merge"), false);
  assert.equal(workflow.includes("pages/builds"), false);
  assert.equal(workflow.includes("pages: write"), false);
  assert.equal(workflow.includes("github.io/fam-website"), false);
  assert.match(prompt, /Никогда не объединяй PR/);
  assert.match(prompt, /необратимые операции/);
  assert.match(prompt, /RLS/);
});

test("workflow does not run database migrations or modify production Supabase", () => {
  assert.doesNotMatch(workflow, /supabase db (?:push|reset|migrate)|supabase functions deploy/i);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|openai-api-key/i);
});

test("Qwen benchmark mode remains opt-in and cannot bypass production approvals", () => {
  assert.match(runner, /FAM_NARROW_TIMEAGO_BENCHMARK === "1"/);
  assert.match(runner, /narrowTimeAgo \? narrowPatchSchema : patchSchema/);
  assert.match(runner, /requires_approval: true/);
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /gh pr create --draft/);
  assert.doesNotMatch(workflow, /FAM_NARROW_TIMEAGO_BENCHMARK: "1"/);
});

test("general patch uses real file line coordinates, never placeholder hunk offsets", () => {
  assert.match(runner, /Фрагмент/);
  assert.match(runner, /реальные номера строк оригинального файла/);
  assert.match(runner, /Не подставляй произвольное/);
  assert.match(runner, /normalizeUnifiedDiffHunkCounts/);
});

test("PR126 general planner runtime test cannot write or alter production", () => {
  assert.match(integrationTrialWorkflow, /^on:\n\s+pull_request:/m);
  assert.match(integrationTrialWorkflow, /github\.event\.pull_request\.number == 126/);
  assert.match(integrationTrialWorkflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(integrationTrialWorkflow, /permissions:\n\s+contents: read/);
  assert.match(integrationTrialWorkflow, /FAM_NARROW_TIMEAGO_BENCHMARK: "0"/);
  assert.match(integrationTrialWorkflow, /uses: actions\/cache\/restore@[0-9a-f]{40} # actions\/cache restore v4/);
  assert.doesNotMatch(integrationTrialWorkflow, /uses: actions\/cache@[0-9a-f]{40}/);
  assert.match(integrationTrialWorkflow, /key: fam-qwen38-27b-iq2xs-v1/);
  assert.match(integrationTrialWorkflow, /if \[\[ "\$CACHED_SHA" == "\$MODEL_SHA256" \]\]/);
  assert.match(integrationTrialWorkflow, /Using verified cached Qwen3\.8 weights/);
  assert.match(integrationTrialWorkflow, /No valid cached weights; downloading pinned Qwen3\.8 file/);
  const cacheDownloadBranch = integrationTrialWorkflow.match(
    /if \[\[ "\$CACHED_SHA" == "\$MODEL_SHA256" \]\][\s\S]*?\n          fi\n          SIZE=/,
  )?.[0];
  assert.ok(cacheDownloadBranch, "weight download must be guarded by cache verification");
  assert.match(cacheDownloadBranch, /then[\s\S]*Using verified cached Qwen3\.8 weights[\s\S]*else[\s\S]*curl --fail[\s\S]*\n          fi/);
  assert.equal(
    (integrationTrialWorkflow.match(/https:\/\/huggingface\.co\/sammyblues\/Qwen3\.8-27B-IQ2_XS-GGUF/g) ?? []).length,
    1,
    "only one model-download URL should exist, inside the cache-miss branch",
  );
  assert.match(integrationTrialWorkflow, /НЕ вызывай isNaN\(isoOrMs\)/);
  assert.match(integrationTrialWorkflow, /Number\.isFinite\(t\)/);
  assert.match(integrationTrialWorkflow, /Если unified_diff непустой, evidence обязательно содержит минимум одну точную ссылку/);
  assert.match(integrationTrialWorkflow, /верни пустые unified_diff и evidence и укажи конкретное препятствие в root_cause/);
  assert.match(integrationTrialWorkflow, /node --test tests\/agent-benchmark\/time-ago\.test\.mjs/);
  assert.match(integrationTrialWorkflow, /node scripts\/validate-local-agent-no-patch\.mjs "\$SUMMARY"/);
  assert.match(integrationTrialWorkflow, /QA="no_patch_validated"/);
  assert.match(integrationTrialWorkflow, /\[\[ "\$QA" == passed \|\| "\$QA" == no_patch_validated \]\]/);
  assert.match(noPatchValidator, /report\.verification_status === "not_run_no_patch"/);
  assert.match(noPatchValidator, /report\.patch_available === false/);
  assert.match(integrationTrialWorkflow, /QA="report_generation_failed"/);
  assert.match(integrationTrialWorkflow, /\[\[ ! -s "\$SUMMARY" && -s "\$PATCH" \]\]/);
  assert.doesNotMatch(integrationTrialWorkflow, /secrets\.|contents: write|gh pr merge|supabase db push/);
});

test("general Qwen planner stays model-authored with compact JSON and independent approval", () => {
  assert.match(runner, /function planningSourceContext\(path, task\)/);
  assert.match(runner, /required: \["finding_status", "files", "plan"\]/);
  assert.match(runner, /\], planSchema, 650\)/);
  assert.match(runner, /required: \["unified_diff", "root_cause", "evidence"\]/);
  assert.match(runner, /evidence: \{ type: "array", items: \{ type: "string" \}, maxItems: 8 \}/);
  assert.match(runner, /Если предлагаешь непустой unified_diff, evidence обязательно содержит минимум одну проверяемую ссылку/);
  assert.match(runner, /verifyModelEvidence\(response\.evidence, sourceByPath\)/);
  assert.match(runner, /Model proposed a patch without verifiable source evidence; patch withheld/);
  assert.match(runner, /if \(plan\.finding_status !== "issue_found"/);
  assert.match(runner, /return isAllowedAgentPath\(path\)/);
  assert.match(runner, /Unverified model-generated candidate; independent QA and owner approval required/);
  assert.match(runner, /requires_approval: true/);
  assert.doesNotMatch(runner, /if \(narrowTimeAgo\) return \{ unified_diff:/);
});

test("general timeAgo context is source-exact without bypassing model planning", () => {
  assert.match(runner, /function exactFunctionContext\(path, functionName\)/);
  assert.match(runner, /Expected exactly one declaration of/);
  assert.match(runner, /Cannot locate end of/);
  assert.match(runner, /body = exactFunctionContext\(path, "timeAgo"\)/);
  assert.match(runner, /selected\.length === 1/);
  assert.match(runner, /plan\.plan/);
  assert.match(runner, /return isAllowedAgentPath\(path\)/);
});

test("existing timeAgo benchmark is the only exception to the code-change test requirement", () => {
  assert.ok(workflow.includes('if (( ${#changed_files[@]} == 1 )) && [[ "${changed_files[0]}" == "index.html" ]]'));
  assert.match(workflow, /node scripts\/validate-local-agent-time-ago\.mjs/);
  assert.match(workflow, /node --test tests\/agent-benchmark\/time-ago\.test\.mjs/);
  assert.match(workflow, /node --check scripts\/validate-local-agent-time-ago\.mjs/);
  assert.match(workflow, /Изменение HTML\/JavaScript не содержит регрессионного теста/);
  assert.match(timeAgoScopeValidator, /export function onlyTimeAgoChanged/);
  assert.match(timeAgoScopeValidator, /git/);
  assert.match(timeAgoScopeValidator, /HEAD:index\.html/);
  assert.match(timeAgoScopeValidator, /changed\.length !== 1/);
  assert.doesNotMatch(workflow, /gh pr merge/);
});

test("GitHub approval output uses one validated writer and protects PR creation", () => {
  assert.match(workflow, /node scripts\/validate-local-agent-patch\.mjs/);
  assert.doesNotMatch(workflow, /appendFileSync\(process\.env\.GITHUB_OUTPUT/);
  assert.match(workflow, /requires_approval: \$\{\{ steps\.safety\.outputs\.requires_approval \}\}/);
  assert.match(workflow, /REQUIRES_APPROVAL: \$\{\{ needs\.verify\.outputs\.requires_approval \}\}/);
  assert.match(validator, /appendFileSync\(/);
  assert.match(validator, /"requires_approval=" \+ String\(result\.requires_approval\) \+ "\\n"/);
  assert.match(workflow, /gh pr create --draft/);
});

test("Qwen cache includes runtime libraries and rejects incomplete cache hits", () => {
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/llama\.cpp\/build\/bin\n\s+key: [^\n]+-v2-runtime/);
  assert.match(workflow, /id: llama-runtime-cache/);
  assert.match(workflow, /dependencies="\$\(ldd "\$SERVER" 2>&1\)" && ! grep -q 'not found'/);
  assert.match(workflow, /steps\.llama-runtime-cache\.outputs\.usable != 'true'/);
  assert.match(workflow, /rm -rf -- "\$RUNNER_TEMP\/llama\.cpp"\n\s+git clone/);
  const isolatedSmoke = workflow.indexOf('"$INFERENCE_SERVER" --version');
  assert.ok(isolatedSmoke > workflow.indexOf('done < <(ldd "$SERVER" | awk'));
  assert.ok(isolatedSmoke < workflow.indexOf('"$INFERENCE_SERVER" -m "$INFERENCE_MODEL"'));
});

test("untrusted QA never receives bridge credentials, including after failed checks", () => {
  const qa = workflow.split("  verify:\n")[1]?.split("  record_qa:\n")[0] || "";
  const record = workflow.split("  record_qa:\n")[1]?.split("  prepare_review:\n")[0] || "";
  const pr = workflow.split("  prepare_review:\n")[1]?.split("  record_pr:\n")[0] || "";
  const final = workflow.split("  record_pr:\n")[1] || "";
  assert.ok(qa && record && pr && final);
  assert.doesNotMatch(qa, /secrets\.|FAM_AGENT_WORKER_TOKEN|FAM_AGENT_BRIDGE_URL|fam-agent-bridge\.mjs advance/);
  assert.doesNotMatch(pr, /secrets\.|FAM_AGENT_WORKER_TOKEN|FAM_AGENT_BRIDGE_URL|fam-agent-bridge\.mjs (advance|heartbeat)/);
  assert.match(qa, /qa_outcome: \$\{\{ steps\.qa_classification\.outputs\.result \}\}/);
  assert.match(qa, /id: qa_classification\n\s+if: always\(\)/);
  assert.match(qa, /id: proposed_tests/);
  assert.match(record, /needs\.verify\.result == 'failure'/);
  assert.match(record, /QA_RESULT: \$\{\{ needs\.verify\.outputs\.qa_outcome \}\}/);
  assert.match(record, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(record, /passed\) export FAM_RESULT_STAGE=qa_passed/);
  assert.match(record, /rejected\) export FAM_RESULT_STAGE=qa_failed/);
  assert.match(record, /qa_unavailable/);
  assert.match(pr, /needs\.record_qa\.result == 'success'/);
  assert.match(final, /needs\.record_qa\.result == 'success'/);
  assert.match(final, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(final, /export FAM_RESULT_STAGE=pr_created/);
  assert.match(final, /export FAM_RESULT_STAGE=pr_ci_failed/);
  assert.match(final, /FAM_PR_NUMBER.*=~.*\[1-9\]/);
  assert.doesNotMatch(final, /PR_CI_FAILED.*qa_failed/);
  assert.match(pr, /FAM_CODER_TASK_ID/);
  assert.doesNotMatch(record + final, /download-artifact|git apply|node --test/);
  assert.equal((workflow.match(/export FAM_RESULT_STAGE=qa_passed/g) || []).length, 1);
});
test("PR creation validates staged changes independently, including new files", () => {
  const qa = workflow.split("  verify:\n")[1].split("  record_qa:\n")[0];
  const pr = workflow.split("  prepare_review:\n")[1].split("  record_pr:\n")[0];
  for (const block of [qa, pr]) {
    assert.match(block, /git apply --index/);
    assert.match(block, /git diff --cached --name-only -z HEAD/);
  }
  assert.match(pr, /node scripts\/validate-local-agent-patch\.mjs/);
  assert.match(pr, /git diff --cached --raw --no-renames/);
  assert.match(pr, /needs\.record_qa\.result == 'success'/);
});

test("trusted QA writeback maps independent pass, rejection, and unavailable results", () => {
  const record = workflow.split("  record_qa:\n")[1]?.split("  prepare_review:\n")[0] || "";
  const marker = "        run: |\n";
  const blocks = record.split(marker);
  assert.equal(blocks.length, 2, "exactly one bridge writeback shell must be present");
  const shell = blocks[1].split("\n  prepare_review:")[0].split("\n").map(line => {
    assert.ok(!line.trim() || line.startsWith("          "), "unexpected YAML indentation");
    return line.trim() ? line.slice(10) : "";
  }).join("\n");
  const stub = 'node() { test "$#" -eq 2 && test "$1" = "scripts/fam-agent-bridge.mjs" && test "$2" = "advance" && printf "%s\\n" "$FAM_RESULT_STAGE"; }\n';
  for (const [qa, expected] of [["passed", "qa_passed"], ["rejected", "qa_failed"], ["unavailable", "qa_unavailable"], ["", "qa_unavailable"]]) {
    const result = spawnSync("bash", ["-c", stub + shell], {
      env: { PATH: process.env.PATH, QA_RESULT: qa }, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  for (const qa of ["cancelled", "skipped", "unknown"]) {
    const result = spawnSync("bash", ["-c", stub + shell], {
      env: { PATH: process.env.PATH, QA_RESULT: qa }, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});

test("stacked rollback fixtures preserve deterministic ordering without assuming event columns", () => {
  const rollback = readFileSync(
    new URL("../../tests/fixtures/fam-qa-failure/lifecycle-178-rollback.sql", import.meta.url),
    "utf8",
  );
  const reapply = readFileSync(
    new URL("../../tests/fixtures/fam-qa-failure/lifecycle-178-reapply.sql", import.meta.url),
    "utf8",
  );
  assert.equal((rollback.match(/jsonb_agg\(to_jsonb\(e\) order by to_jsonb\(e\)::text\)/g) || []).length, 2);
  assert.doesNotMatch(rollback, /e\.(?:created_at|event_type|id)\b/);
  assert.match(reapply, /where e\.metadata->>'stage' = 'postmerge_verified'\s+order by e\.task_id, e\.metadata::text\s+limit 1/);
});

test("created PR is recorded from its job output when CI is unavailable so retries do not duplicate it", () => {
  assert.match(workflow, /gh pr list --state open --search "in:body \$FAM_CODER_TASK_ID"/);
  assert.match(workflow, /scripts\/find-fam-agent-task-pr\.mjs/);
  const recordJob = workflow.split("  record_pr:\n")[1] || "";
  assert.match(recordJob, /needs\.prepare_review\.outputs\.pr_number != ''/);
  assert.match(workflow, /REUSED_EXISTING: \$\{\{ steps\.pr\.outputs\.reused_existing \}\}/);
  assert.match(workflow, /BRANCH="\$PR_HEAD_BRANCH"/);
  assert.match(workflow, /BRANCH_SHA="\$PR_HEAD_SHA"/);
  const branchCi = workflow.split("      - name: Дождаться независимых проверок PR и оставить его на утверждение владельца")[1]?.split("      - name: Сохранить отчёт о PR")[0] || "";
  assert.ok(branchCi);
  assert.match(branchCi, /gh pr view "\$PR_URL" --json headRefOid --jq \.headRefOid/);
  assert.match(branchCi, /TEST_CONCLUSION="\$\(gh run view "\$TEST_RUN_ID" --json conclusion/);
  assert.match(branchCi, /TEST_HEAD_SHA="\$\(gh run view "\$TEST_RUN_ID" --json headSha/);
  assert.match(branchCi, /"\$TEST_HEAD_SHA" != "\$BRANCH_SHA"/);
  assert.ok(branchCi.includes('if [[ "$TEST_CONCLUSION" != "success" ]]; then'));
  assert.match(branchCi, /Ревизия PR изменилась во время проверки/);
  assert.match(workflow, /if: success\(\)\n\s+env:\n\s+GH_TOKEN:/);
  assert.doesNotMatch(workflow, /if: success\(\) && steps\.pr\.outputs\.reused_existing/);
  const marker = "        run: |\n";
  const blocks = recordJob.split(marker);
  assert.equal(blocks.length, 2);
  const lines = blocks[1].split("\n").filter(line => line.trim());
  const executable = lines.map(line => {
    assert.ok(line.startsWith("          "), "unexpected YAML indentation in record_pr shell");
    return line.slice(10);
  }).join("\n");
  const stub = 'node() { test "$#" -eq 2 && test "$1" = "scripts/fam-agent-bridge.mjs" && test "$2" = "advance" && printf "%s\\n" "$FAM_RESULT_STAGE"; }\n';
  for (const [env, expected] of [
    [{ FAM_PR_NUMBER: "149", PR_RESULT: "success", PR_CI_FAILED: "" }, "pr_created"],
    [{ FAM_PR_NUMBER: "149", PR_RESULT: "failure", PR_CI_FAILED: "true" }, "pr_ci_failed"],
    [{ FAM_PR_NUMBER: "149", PR_RESULT: "failure", PR_CI_FAILED: "" }, "pr_created"],
  ]) {
    const result = spawnSync("bash", ["-c", stub + executable], {
      env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  const missing = spawnSync("bash", ["-c", stub + executable], {
    env: { PATH: process.env.PATH, FAM_PR_NUMBER: "", PR_RESULT: "failure", PR_CI_FAILED: "" },
    encoding: "utf8", timeout: 5000,
  });
  assert.ifError(missing.error);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
});
