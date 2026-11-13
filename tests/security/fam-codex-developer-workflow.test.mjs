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
const reportWorkflow = readFileSync(
  new URL("../../.github/workflows/fam-agent-daily-report.yml", import.meta.url),
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

test("the queue is checked before model download and compilation, and empty runs skip them", () => {
  const queueIndex = workflow.indexOf("Получить одно безопасное задание из очереди");
  const downloadIndex = workflow.indexOf("Скачать бесплатную модель");
  const buildIndex = workflow.indexOf("Собрать llama.cpp");
  assert.ok(queueIndex >= 0 && queueIndex < downloadIndex && queueIndex < buildIndex);
  assert.match(workflow, /run_model == 'true'[\s\S]*?name: Скачать бесплатную модель/);
  assert.match(workflow, /run_model == 'true'[\s\S]*?name: Собрать llama\.cpp/);
  assert.match(workflow, /run_model != 'true'[\s\S]*?Модель не загружалась/);
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

test("all coder-editable paths trigger required CI and PR manager waits with read-only workflow permissions", () => {
  const pullRequestPaths = testWorkflow.split("  pull_request:")[1]?.split("\npermissions:")[0] ?? "";
  for (const path of ["'css/**'", "'js/**'", "'assets/**'", "'docs/**'"]) {
    assert.ok(pullRequestPaths.includes(path), `missing PR CI path: ${path}`);
  }
  assert.match(workflow, /gh pr checks "\$PR_URL" --required --json name,state,bucket/);
  assert.match(workflow, /REQUIRED_BUCKET/);
  assert.match(workflow, /Russian content safety tests/);
  assert.doesNotMatch(workflow, /commits\/\$BRANCH_SHA\/check-runs/);
  assert.doesNotMatch(workflow, /gh workflow run \.github\/workflows\/moderation-regression\.yml/);
  assert.doesNotMatch(workflow, /actions: write/);
});

test("agent PRs stay draft and the workflow does not request ready or merge transitions", () => {
  assert.match(validator, /CRITICAL_CHANGE_PATTERNS/);
  assert.match(validator, /export function requiresManualApproval/);
  const createCommands = workflow.split("\n").filter((line) => line.includes("gh pr create"));
  assert.equal(createCommands.length, 1, "agent has exactly one PR creation path");
  assert.match(createCommands[0], /--draft/);
  assert.doesNotMatch(workflow, /gh pr create --base/);
  assert.doesNotMatch(workflow, /REQUIRES_APPROVAL/);
  assert.match(workflow, /отдельного явного разрешения владельца/);
  assert.equal(workflow.includes("gh pr merge"), false);
  assert.doesNotMatch(workflow, /gh pr ready/);
  assert.doesNotMatch(workflow, /gh api\s+-X\s+(?:PUT|PATCH|POST).*pulls/i);
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
  assert.match(runner, /"--check", "--reverse"/);
  assert.match(runner, /for \(const \[path, source\] of originalSources\)/);
  assert.match(runner, /Keep the generation checkout pristine/);
  assert.doesNotMatch(runner, /unified_diff:\s*\{\s*type:\s*"string"/);
  assert.match(prompt, /точные операции search\/replace/);
  assert.match(prompt, /runner сам внесёт точные изменения и сформирует patch через git diff/);
});

test("the main agent workflow tests the exact edit helper", () => {
  assert.match(workflow, /local-model-edits\.test\.mjs/);
  assert.match(workflow, /node --check scripts\/local-model-edits\.mjs/);
});


test("explicitly referenced unselected tests are supplied as read-only source context", () => {
  assert.match(runner, /const readOnlyExcerpts = taskReferencedSource/);
  assert.match(runner, /Контекст только для чтения/);
  assert.match(runner, /Остальные файлы в source_context помечены как контекст только для чтения/);
});

test("claimed queue tasks are completed only after independent QA", () => {
  const generateJob = workflow.split("\\n  verify:")[0] ?? "";
  assert.doesNotMatch(generateJob, /fam-agent-bridge\\.mjs finish/);
  assert.ok(workflow.includes("task_id: ${{ steps.coder-queue.outputs.task_id }}"));
  assert.ok(workflow.includes("finish_task:\\n    name: Зафиксировать результат coder после независимого QA\\n    needs: [generate, verify]"));
  assert.ok(workflow.includes("FAM_QA_OUTCOME: ${{ needs.verify.result }}"));
  assert.ok(workflow.includes("run: node scripts/fam-agent-bridge.mjs finish"));
});

test("draft PR creation depends on the independent Reviewer artifact after QA", () => {
  assert.match(workflow, /Подготовить независимый статический Reviewer отчёт/);
  assert.match(workflow, /FAM_QA_STATUS: passed/);
  assert.match(workflow, /node scripts\/fam-agent-reviewer\.mjs/);
  assert.match(workflow, /name: fam-agent-independent-review/);
  assert.match(workflow, /Скачать независимый Reviewer отчёт/);
  assert.match(workflow, /cat "\$RUNNER_TEMP\/fam-agent-review\/review\.md"/);
  assert.match(workflow, /prepare_review:[\s\S]*?needs: \[generate, verify\]/);
  assert.match(workflow, /needs\.verify\.result == 'success'/);
});

test("separate Security and Performance reports gate independent QA and reach the PR", () => {
  assert.match(workflow, /Запустить отдельный статический Security Agent/);
  assert.match(workflow, /node scripts\/fam-agent-security\.mjs/);
  assert.match(workflow, /Запустить отдельный статический Performance Agent/);
  assert.match(workflow, /node scripts\/fam-agent-performance\.mjs/);
  assert.match(workflow, /name: fam-agent-independent-review/);
  assert.match(workflow, /cat "\$RUNNER_TEMP\/fam-agent-review\/security\.md"/);
  assert.match(workflow, /cat "\$RUNNER_TEMP\/fam-agent-review\/performance\.md"/);
  assert.match(workflow, /node --check scripts\/fam-agent-security\.mjs/);
  assert.match(workflow, /node --check scripts\/fam-agent-performance\.mjs/);
});

test("daily Reporter runs on main with read-only scopes and private persistence", () => {
  assert.ok(reportWorkflow.includes('cron: "15 4 * * *"'));
  assert.ok(reportWorkflow.includes("if: github.ref == 'refs/heads/main'"));
  assert.match(reportWorkflow, /actions: read/);
  assert.match(reportWorkflow, /deployments: read/);
  assert.match(reportWorkflow, /pull-requests: read/);
  assert.doesNotMatch(reportWorkflow, /(?:contents|actions|deployments|pull-requests): write/);
  assert.doesNotMatch(reportWorkflow, /upload-artifact|GITHUB_STEP_SUMMARY/);
  assert.match(reportWorkflow, /FAM_AGENT_BRIDGE_URL/);
  assert.ok(reportWorkflow.includes("node scripts/fam-agent-system-reporter.mjs"));
});
