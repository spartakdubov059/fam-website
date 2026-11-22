import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("local FAM coding agent has scheduled and owner-only manual triggers", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.ok(workflow.includes("branches: [main]"));
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron: ["']15 3 \* \* \*["']/);
  assert.match(workflow, /github\.actor == 'spartakdubov059'/);
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
