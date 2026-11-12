import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUnifiedDiffHunkCounts } from "../../scripts/local-model-patch.mjs";

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
  assert.match(fixed, /@@ -20,2 \+22,2 @@ second/);
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
