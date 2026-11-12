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
  assert.match(workflow, /Qwen2\.5-Coder-7B-Instruct-GGUF/);
  assert.match(workflow, /ggml-org\/llama\.cpp/);
  assert.match(workflow, /127\.0\.0\.1:8080/);
  assert.match(runner, /127\.0\.0\.1:8080\/v1\/chat\/completions/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|openai-api-key|openai\/codex-action/i);
  assert.doesNotMatch(runner, /api\.openai\.com|OPENAI_API_KEY/);
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

test("the local coder uses exact edit operations and Git-generated patches", () => {
  assert.match(runner, /extractExplicitTargetPaths/);
  assert.match(runner, /applyTextEdits/);
  assert.match(runner, /"diff"/);
  assert.match(runner, /apply --check --reverse/);
  assert.doesNotMatch(runner, /unified_diff:\s*\{\s*type:\s*"string"/);
  assert.match(prompt, /точные операции search\/replace/);
  assert.match(prompt, /runner сам внесёт точные изменения и сформирует patch через git diff/);
});

test("the main agent workflow tests the exact edit helper", () => {
  assert.match(workflow, /local-model-edits\.test\.mjs/);
  assert.match(workflow, /node --check scripts\/local-model-edits\.mjs/);
});
