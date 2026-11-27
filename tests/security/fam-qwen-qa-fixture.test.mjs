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
const safetyScript = blocks[1].split("\n      - name:")[0].split("\n").map(line => {
  assert.ok(!line.trim() || line.startsWith("          "), "unexpected YAML indentation");
  return line.trim() ? line.slice(10) : "";
}).join("\n");

function fixture(t, change, { stale = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fam-qa-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const runner = join(root, "runner");
  const artifact = join(runner, "fam-agent");
  const output = join(root, "github-output");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "docs"));
  mkdirSync(join(repo, "js"));
  mkdirSync(artifact, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: root, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    RUNNER_TEMP: runner, GITHUB_OUTPUT: output };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  copyFileSync(validator, join(repo, "scripts/validate-local-agent-patch.mjs"));
  writeFileSync(join(repo, "docs/readme.md"), "# Synthetic fixture\n");
  writeFileSync(join(repo, "js/app.js"), "export const value = 1;\n");
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
    output };
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
