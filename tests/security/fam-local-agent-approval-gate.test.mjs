import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url),
  "utf8",
);
const appSetup = readFileSync(
  new URL("../../docs/FAM_AGENT_GITHUB_APP_SETUP.md", import.meta.url),
  "utf8",
);

test("local AI developer can prepare a PR and wait for the required independent check", () => {
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /REQUIRED_CHECK="Russian content safety tests"/);
  assert.match(workflow, /gh pr checks "\$PR_URL" --required --json name,state,bucket/);
  assert.match(workflow, /REQUIRED_BUCKET/);
  assert.doesNotMatch(workflow, /check-runs/);
  assert.doesNotMatch(workflow, /gh workflow run \.github\/workflows\/moderation-regression\.yml/);
  assert.match(workflow, /gh pr comment/);
});

test("automated PR creation can use a repository-scoped App token without broadening permissions", () => {
  assert.match(workflow, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(workflow, /client-id: \$\{\{ vars\.FAM_GITHUB_APP_CLIENT_ID \}\}/);
  assert.match(workflow, /private-key: \$\{\{ secrets\.FAM_GITHUB_APP_PRIVATE_KEY \}\}/);
  assert.match(workflow, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.doesNotMatch(workflow, /permission-checks:/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \|\| github\.token \}\}/);
  assert.match(workflow, /FAM_PR_TOKEN_MODE/);
});

test("App setup documents merge capability and requires native main review protection", () => {
  assert.match(appSetup, /Contents: write.*Merge Pull Request API/s);
  assert.match(appSetup, /required_approving_review_count=0/);
  assert.match(appSetup, /Не устанавливай App token.*нативное правило одобрения/s);
});

test("local AI developer cannot merge PRs or publish production", () => {
  assert.doesNotMatch(workflow, /gh pr merge\b/);
  assert.doesNotMatch(workflow, /pages\/builds/);
  assert.doesNotMatch(workflow, /pages:\s*write/);
  assert.doesNotMatch(workflow, /curl[^\n]*github\.io/);
  assert.match(workflow, /отдельного явного разрешения владельца/);
});

test("local AI developer audits approved source changes as well as its own rules", () => {
  assert.match(workflow, /"index\.html"/);
  assert.match(workflow, /"css\/\*\*"/);
  assert.match(workflow, /"js\/\*\*"/);
  assert.match(workflow, /"assets\/\*\*"/);
  assert.match(workflow, /"tests\/\*\*"/);
});
