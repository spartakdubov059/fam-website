import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  frameSingleFileHunkDiff,
  normalizeUnifiedDiffHunkCounts,
} from "../../scripts/local-model-patch.mjs";

test("repairs incorrect old and new line counts without changing patch content", () => {
  const patch = [
    "diff --git a/tests/fixture.mjs b/tests/fixture.mjs",
    "index 1234567..89abcde 100644",
    "--- a/tests/fixture.mjs",
    "+++ b/tests/fixture.mjs",
    "@@ -1,4 +1,4 @@",
    "-export function normalize(value) {",
    "+export function normalize(value) {",
    "   return String(value).trim();",
    " }",
  ].join("\n") + "\n";

  const fixed = normalizeUnifiedDiffHunkCounts(patch);
  assert.match(fixed, /@@ -1,3 \+1,3 @@/);
  assert.equal(fixed.split("\n").slice(5).join("\n"), patch.split("\n").slice(5).join("\n"));
});

test("recalculates each hunk independently, including insertions and deletions", () => {
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -2,99 +2,99 @@ first",
    " keep",
    "-old",
    "+new",
    "+extra",
    "@@ -20 +22,8 @@ second",
    "-removed",
    " context",
    "\\ No newline at end of file",
  ].join("\n");

  const fixed = normalizeUnifiedDiffHunkCounts(patch);
  assert.match(fixed, /@@ -2,2 \+2,3 @@ first/);
  assert.match(fixed, /@@ -20,2 \+22,1 @@ second/);
});

test("normalizes Windows line endings", () => {
  const patch = [
    "diff --git a/a b/a",
    "--- a/a",
    "+++ b/a",
    "@@ -1,7 +1,8 @@",
    "-before",
    "+after",
    " context",
  ].join("\r\n");

  const fixed = normalizeUnifiedDiffHunkCounts(patch);
  assert.doesNotMatch(fixed, /\r/);
  assert.match(fixed, /@@ -1,2 \+1,2 @@/);
});

test("rejects malformed hunk bodies instead of guessing", () => {
  const patch = [
    "diff --git a/a b/a",
    "--- a/a",
    "+++ b/a",
    "@@ -1,1 +1,1 @@",
    "this line has no diff prefix",
  ].join("\n");

  assert.throws(() => normalizeUnifiedDiffHunkCounts(patch), /Unrecognized unified diff hunk line/);
});

test("frames an unlabelled hunk only for one explicit allowlisted file", () => {
  const framed = frameSingleFileHunkDiff(
    "@@ -1,1 +1,1 @@\n-old\n+new",
    "tests/fixture.mjs",
  );

  assert.match(framed, /^diff --git a\/tests\/fixture\.mjs b\/tests\/fixture\.mjs\n/);
  assert.match(framed, /--- a\/tests\/fixture\.mjs\n\+\+\+ b\/tests\/fixture\.mjs\n@@ -1,1 \+1,1 @@/);
  assert.throws(() => frameSingleFileHunkDiff("@@ -1 +1 @@\n-old\n+new", "../secrets.txt"), /disallowed path/);
  assert.throws(() => frameSingleFileHunkDiff("--- a/a\n+++ b/a", "tests/fixture.mjs"), /start with a unified diff hunk/);
});

test("frames file-labelled unified hunks only when both headers match the selected file", () => {
  const framed = frameSingleFileHunkDiff(
    "--- a/tests/fixture.mjs\n+++ b/tests/fixture.mjs\n@@ -1 +1 @@\n-old\n+new",
    "tests/fixture.mjs",
  );
  assert.match(framed, /^diff --git a\/tests\/fixture\.mjs b\/tests\/fixture\.mjs\n/);
  assert.match(framed, /@@ -1 \+1 @@\n-old\n\+new$/);
  assert.throws(
    () => frameSingleFileHunkDiff("--- a/tests/other.mjs\n+++ b/tests/other.mjs\n@@ -1 +1 @@", "tests/fixture.mjs"),
    /selected path/,
  );
});

test("git apply accepts a framed hunk against the selected file", () => {
  const root = mkdtempSync(join(tmpdir(), "fam-model-patch-"));
  const relativePath = "tests/fixture.mjs";
  const source = "export const value = 'old';\n";
  const target = "export const value = 'new';\n";

  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, relativePath), source);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const patch = frameSingleFileHunkDiff(
      "@@ -1,1 +1,1 @@\n-" + source.trimEnd() + "\n+" + target.trimEnd(),
      relativePath,
    );

    assert.doesNotThrow(() =>
      execFileSync("git", ["apply", "--check", "-"], { cwd: root, input: patch + "\n" }),
    );
    assert.equal(readFileSync(join(root, relativePath), "utf8"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
