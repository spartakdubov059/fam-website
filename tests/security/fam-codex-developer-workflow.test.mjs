import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url),
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

test("local FAM coding agent has scheduled and owner-only manual triggers", () => {
  assert.match(workflow, /workflow_dispatch:/);
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

test("the independent verification job runs without model or write credentials", () => {
  assert.match(workflow, /verify:\n[\s\S]*?permissions:\n\s+contents: read/);
  assert.match(workflow, /node --test tests\/moderation\/\*\.test\.mjs tests\/security\/\*\.test\.mjs/);
  assert.match(workflow, /node --check \/tmp\/fam-inline-scripts\.js/);
  assert.match(workflow, /git diff --check HEAD/);
  assert.match(workflow, /has_tests=false/);
  assert.match(workflow, /Изменение кода сайта не содержит регрессионного теста/);
});

test("critical changes require manual approval; only passed low-risk PRs may merge", () => {
  assert.match(validator, /CRITICAL_CHANGE_PATTERNS/);
  assert.match(validator, /export function requiresManualApproval/);
  assert.match(workflow, /if: steps\.pr\.outputs\.requires_approval == 'false'/);
  assert.match(workflow, /gh pr checks "\$PR_URL" --watch --fail-fast/);
  assert.match(workflow, /gh pr merge "\$PR_URL" --squash --delete-branch/);
  assert.match(workflow, /gh pr create --draft/);
  assert.match(workflow, /pages build and deployment/);
  assert.match(prompt, /необратимые операции/);
  assert.match(prompt, /RLS/);
});

test("workflow does not run database migrations or modify production Supabase", () => {
  assert.doesNotMatch(workflow, /supabase db (?:push|reset|migrate)|supabase functions deploy/i);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|openai-api-key/i);
});
