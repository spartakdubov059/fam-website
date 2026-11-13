import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url),
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
