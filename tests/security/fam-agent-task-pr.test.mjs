import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findOpenTaskPr } from "../../scripts/find-fam-agent-task-pr.mjs";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const marker = `- FAM task ID: \`${TASK_ID}\``;

test("task lookup reuses only an open PR with the exact task marker", () => {
  const rows = [
    { number: 40, url: "https://github.com/example/repo/pull/40", body: "Different task FAM task ID: 22222222-2222-4222-8222-222222222222" },
    { number: 41, url: "https://github.com/example/repo/pull/41", body: `Report\n${marker}` },
    { number: 42, url: "https://github.com/example/repo/pull/42", body: `Similar prefix ${marker}x` },
  ];
  assert.deepEqual(findOpenTaskPr(rows, TASK_ID), rows[1]);
  assert.equal(findOpenTaskPr(rows.slice(0, 1), TASK_ID), null);
});

test("task lookup fails closed if multiple open PRs match the same task", () => {
  const duplicate = [
    { number: 41, url: "https://github.com/example/repo/pull/41", body: marker },
    { number: 42, url: "https://github.com/example/repo/pull/42", body: marker },
  ];
  assert.throws(() => findOpenTaskPr(duplicate, TASK_ID), /Multiple open PRs/);
});

test("task lookup rejects malformed input and ignores rows without a safe PR number", () => {
  assert.throws(() => findOpenTaskPr({}, TASK_ID), /Invalid task PR lookup input/);
  assert.throws(() => findOpenTaskPr([], ""), /Invalid task PR lookup input/);
  assert.equal(findOpenTaskPr([{ number: "41", url: "https://github.com/x/y/pull/41", body: marker }], TASK_ID), null);
});

test("CLI returns a tab-separated existing PR and emits no output on ambiguous matches", () => {
  const script = fileURLToPath(new URL("../../scripts/find-fam-agent-task-pr.mjs", import.meta.url));
  const row = { number: 41, url: "https://github.com/example/repo/pull/41", body: marker };
  const found = spawnSync(process.execPath, [script, TASK_ID], {
    input: JSON.stringify([row]), encoding: "utf8", timeout: 5000,
  });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, `${row.number}\t${row.url}\n`);
  const ambiguous = spawnSync(process.execPath, [script, TASK_ID], {
    input: JSON.stringify([row, { ...row, number: 42, url: "https://github.com/example/repo/pull/42" }]),
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.stdout, "");
});
