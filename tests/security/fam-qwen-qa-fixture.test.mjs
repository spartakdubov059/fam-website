import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url), "utf8");
const validator = new URL("../../scripts/validate-local-agent-patch.mjs", import.meta.url);
const qa = workflow.split("  verify:\n")[1]?.split("  record_qa:\n")[0] || "";
const marker = "        id: safety\n        run: |\n";
const blocks = qa.split(marker);
assert.equal(blocks.length, 2, "test must execute the actual production QA safety step");
function extractStep(id) {
  const parts = qa.split("        id: " + id + "\n        run: |\n");
  assert.equal(parts.length, 2);
  return parts[1].split("\n      - name:")[0].split("\n").map(line => {
    assert.ok(!line.trim() || line.startsWith("          "), "unexpected YAML indentation");
    return line.trim() ? line.slice(10) : "";
  }).join("\n");
}
const safetyScript = extractStep("safety");
const proposedScript = extractStep("proposed_tests");
const branchWorkflow = readFileSync(new URL("../../.github/workflows/moderation-regression.yml", import.meta.url), "utf8");
const branchStep = branchWorkflow.split("        id: proposed_tests\n        run: |\n");
assert.equal(branchStep.length, 2);
const branchScript = branchStep[1].split("\n      - name:")[0].split("\n").map(line => {
  assert.ok(!line.trim() || line.startsWith("          "));
  return line.trim() ? line.slice(10) : "";
}).join("\n");
assert.equal(branchScript.trimEnd(), proposedScript.trimEnd(), "QA and independent branch CI must execute identical proposed tests");

function fixture(t, change, { stale = false, failingBaseline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fam-qa-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const runner = join(root, "runner");
  const artifact = join(runner, "fam-agent");
  const output = join(root, "github-output");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "docs"));
  mkdirSync(join(repo, "js"));
  mkdirSync(join(repo, "tests", "agent-proposed"), { recursive: true });
  mkdirSync(artifact, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: root, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    RUNNER_TEMP: runner, GITHUB_OUTPUT: output };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  copyFileSync(validator, join(repo, "scripts/validate-local-agent-patch.mjs"));
  writeFileSync(join(repo, "docs/readme.md"), "# Synthetic fixture\n");
  writeFileSync(join(repo, "js/app.js"), "export const value = 1;\n");
  writeFileSync(join(repo, "tests/agent-proposed/existing.test.mjs"), failingBaseline
    ? "import test from 'node:test'; test('accumulated regression', () => { throw Error('synthetic baseline failure'); });\n"
    : "import test from 'node:test'; test('baseline', () => {});\n");
  git("init", "-q");
  git("config", "user.name", "FAM synthetic QA");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "synthetic baseline");
  const base = git("rev-parse", "HEAD").trim();
  change(repo);
  git("add", "-A");
  const patch = git("diff", "--cached", "--binary", "HEAD");
  assert.match(patch, /diff --git/);
  git("reset", "--hard", "HEAD");
  writeFileSync(join(artifact, "fam-agent.patch"), patch);
  writeFileSync(join(artifact, "base.sha"), (stale ? "0".repeat(40) : base) + "\n");
  writeFileSync(join(artifact, "summary.json"), JSON.stringify({ risk: "low", requires_approval: true }));
  const result = spawnSync("bash", ["-c", safetyScript], {
    cwd: repo, env, encoding: "utf8", timeout: 15000,
  });
  assert.ifError(result.error);
  return { status: result.status, logs: result.stdout + result.stderr,
    paths: git("diff", "--cached", "--name-only", "HEAD").trim(),
    output,
    runProposed: () => spawnSync("bash", ["-c", proposedScript], {
      cwd: repo, env, encoding: "utf8", timeout: 15000
    }) };
}

test("actual QA safety step accepts a regular new documentation file", t => {
  const r = fixture(t, repo => writeFileSync(join(repo, "docs/new.md"), "Synthetic QA fixture only.\n"));
  assert.equal(r.status, 0, r.logs);
  assert.equal(r.paths, "docs/new.md");
  assert.match(readFileSync(r.output, "utf8"), /requires_approval=true/);
});

test("actual QA safety step rejects a stale baseline", t => {
  const r = fixture(t, repo => writeFileSync(join(repo, "docs/new.md"), "Synthetic QA fixture only.\n"), { stale: true });
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /Patch устарел/);
  assert.equal(r.paths, "");
});

test("actual QA safety step rejects protected paths even when the validator permits an infrastructure proposal", t => {
  const r = fixture(t, repo => writeFileSync(join(repo, "scripts/fam-agent-governance.mjs"), "// Synthetic fixture; never executed.\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /Запрещённый путь в patch/);
});

test("actual QA safety step rejects a symlink in an otherwise allowed path", t => {
  const r = fixture(t, repo => symlinkSync("readme.md", join(repo, "docs/link.md")));
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /Non-regular file/);
});

test("actual QA safety step rejects behavior changes without a regression test", t => {
  const r = fixture(t, repo => writeFileSync(join(repo, "js/app.js"), "export const value = 2;\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /не содержит регрессионного теста/);
});

test("a non-test file does not satisfy behavior-change regression requirement", t => {
  const r = fixture(t, repo => {
    writeFileSync(join(repo, "js/app.js"), "export const value = 2;\n");
    writeFileSync(join(repo, "tests/agent-proposed/notes.txt"), "Not a test.\n");
  });
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /не содержит регрессионного теста/);
});

test("deleting a test does not satisfy behavior-change regression requirement", t => {
  const r = fixture(t, repo => {
    writeFileSync(join(repo, "js/app.js"), "export const value = 2;\n");
    rmSync(join(repo, "tests/agent-proposed/existing.test.mjs"));
  });
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /не содержит регрессионного теста/);
});

test("actual proposed-test step executes new tests and fails on a failing assertion", t => {
  const r = fixture(t, repo => {
    writeFileSync(join(repo, "js/app.js"), "export const value = 2;\n");
    writeFileSync(join(repo, "tests/agent-proposed/change.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('synthetic regression', () => assert.equal(1, 2));\n");
  });
  assert.equal(r.status, 0, r.logs);
  const result = r.runProposed();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /synthetic regression/);
});

test("actual proposed-test step passes a successful nested test", t => {
  const r = fixture(t, repo => {
    writeFileSync(join(repo, "js/app.js"), "export const value = 2;\n");
    writeFileSync(join(repo, "tests/agent-proposed/change.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('synthetic regression', () => assert.equal(2, 2));\n");
  });
  assert.equal(r.status, 0, r.logs);
  const result = r.runProposed();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /synthetic regression/);
});

test("an unchanged previously accepted proposed test is rerun for every subsequent patch", t => {
  const r = fixture(t, repo => writeFileSync(join(repo, "docs/new.md"), "New synthetic change.\n"), { failingBaseline: true });
  assert.equal(r.status, 0, r.logs);
  const result = r.runProposed();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /accumulated regression/);
});
test("a test outside the designated proposed suite does not satisfy required coverage", t => {
  const r = fixture(t, repo => {
    writeFileSync(join(repo, "js/app.js"), "export const value = 2;\n");
    writeFileSync(join(repo, "tests/other.test.mjs"), "import test from 'node:test'; test('other', () => {});\n");
  });
  assert.notEqual(r.status, 0);
  assert.match(r.logs, /не содержит регрессионного теста/);
});
