import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findOpenTaskPr } from "../../scripts/find-fam-agent-task-pr.mjs";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY = "example/repo";
const marker = `- FAM task ID: \`${TASK_ID}\``;
const trustedPr = (overrides = {}) => ({
  number: 41,
  url: "https://github.com/example/repo/pull/41",
  body: `Report\n${marker}`,
  author: { login: "github-actions[bot]" },
  baseRefName: "main",
  headRefName: "codex/fam-run-46000000000",
  headRepository: { name: "repo" },
  headRepositoryOwner: { login: "example" },
  isCrossRepository: false,
  ...overrides,
});

test("task lookup reuses only an open PR with the exact task marker", () => {
  const rows = [
    { ...trustedPr(), number: 40, body: "Different task FAM task ID: 22222222-2222-4222-8222-222222222222" },
    trustedPr(),
    { ...trustedPr(), number: 42, body: `Similar prefix ${marker}x` },
  ];
  assert.deepEqual(findOpenTaskPr(rows, TASK_ID, REPOSITORY), rows[1]);
  assert.equal(findOpenTaskPr(rows.slice(0, 1), TASK_ID, REPOSITORY), null);
});

test("task lookup fails closed if multiple open PRs match the same task", () => {
  assert.throws(() => findOpenTaskPr([trustedPr(), { ...trustedPr(), number: 42 }], TASK_ID, REPOSITORY), /Multiple open PRs/);
});

test("task lookup ignores copied markers from untrusted or differently scoped PRs", () => {
  const unsafe = [
    trustedPr({ author: { login: "student" } }),
    trustedPr({ baseRefName: "codex/other-branch" }),
    trustedPr({ headRepository: { name: "fork" }, headRepositoryOwner: { login: "stranger" }, isCrossRepository: true }),
    trustedPr({ headRefName: "attacker/branch" }),
  ];
  assert.equal(findOpenTaskPr(unsafe, TASK_ID, REPOSITORY), null);
});

test("task lookup rejects malformed input and ignores rows without a safe PR number", () => {
  assert.throws(() => findOpenTaskPr({}, TASK_ID, REPOSITORY), /Invalid task PR lookup input/);
  assert.throws(() => findOpenTaskPr([], "", REPOSITORY), /Invalid task PR lookup input/);
  assert.throws(() => findOpenTaskPr([], TASK_ID, "bad-repository"), /Invalid task PR lookup input/);
  assert.equal(findOpenTaskPr([{ ...trustedPr(), number: "41" }], TASK_ID, REPOSITORY), null);
});

test("CLI returns a tab-separated existing PR and emits no output on ambiguous matches", () => {
  const script = fileURLToPath(new URL("../../scripts/find-fam-agent-task-pr.mjs", import.meta.url));
  const row = trustedPr();
  const found = spawnSync(process.execPath, [script, TASK_ID, REPOSITORY], {
    input: JSON.stringify([row]), encoding: "utf8", timeout: 5000,
  });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, `${row.number}\t${row.url}\n`);
  const ambiguous = spawnSync(process.execPath, [script, TASK_ID, REPOSITORY], {
    input: JSON.stringify([row, { ...row, number: 42, url: "https://github.com/example/repo/pull/42" }]),
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.stdout, "");
});
