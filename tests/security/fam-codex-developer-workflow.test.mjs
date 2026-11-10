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

test("Codex developer is manually started only by the repository owner on main", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.actor == 'spartakdubov059'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule):/m);
});

test("Codex is pinned and receives a workspace-only coding profile", () => {
  assert.match(workflow, /openai\/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675/);
  assert.match(workflow, /codex-version: "0\.167\.0"/);
  assert.match(workflow, /permission-profile: ":workspace"/);
  assert.match(workflow, /safety-strategy: "drop-sudo"/);
  assert.match(workflow, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
});

test("AI changes are restricted to site source, documentation and tests", () => {
  assert.match(workflow, /index\.html\|css\/\*\|js\/\*\|assets\/\*\|docs\/\*\|tests\/\*/);
  assert.match(prompt, /Запрещено изменять \.github\/\*\*, любые supabase\/\*/);
  assert.match(prompt, /Не запускай git push, gh pr create\/merge/);
});

test("tests run in a separate job without OpenAI API key and write access", () => {
  assert.match(workflow, /verify:\n[\s\S]*?permissions:\n\s+contents: read/);
  assert.match(workflow, /node --test tests\/moderation\/\*\.test\.mjs tests\/security\/\*\.test\.mjs/);
  assert.match(workflow, /publish-draft-pr:/);
  assert.match(workflow, /needs: \[generate, verify\]/);
});

test("final job only creates a draft PR and never merges or deploys", () => {
  assert.match(workflow, /gh pr create --draft/);
  assert.doesNotMatch(workflow, /gh pr merge|supabase functions deploy|git push origin main/i);
});
