import assert from "node:assert/strict";
import test from "node:test";
import { onlyTimeAgoChanged } from "../../scripts/validate-local-agent-time-ago.mjs";

const original = [
  "<script>",
  "  function other() { return 1; }",
  "  function timeAgo(isoOrMs) {",
  "    if (!isoOrMs) return '';",
  "    return new Date(isoOrMs).toLocaleDateString('ru-RU');",
  "  }",
  "  function after() { return 2; }",
  "</script>",
].join("\n");

const valid = original.replace(
  "    if (!isoOrMs) return '';",
  "    if (isoOrMs == null) return '';",
);

test("an exact change to the existing timeAgo function can use an unchanged independent regression test", () => {
  assert.equal(onlyTimeAgoChanged(original, valid), true);
});

test("rejects no-op changes, changes outside the function, and missing function", () => {
  assert.equal(onlyTimeAgoChanged(original, original), false);
  assert.equal(onlyTimeAgoChanged(original, valid.replace("return 2;", "return 3;")), false);
  assert.equal(onlyTimeAgoChanged(original, valid + "\n// unrelated code"), false);
  assert.equal(onlyTimeAgoChanged(original, valid.replace("timeAgo(isoOrMs)", "timeAgo(value)")), false);
  assert.equal(onlyTimeAgoChanged(original, valid.replace("  function timeAgo(isoOrMs) {", "")), false);
});

test("rejects duplicate function declarations and function changes with unrelated edits", () => {
  const duplicate = valid + "\n  function timeAgo(isoOrMs) { return ''; }";
  assert.equal(onlyTimeAgoChanged(original, duplicate), false);
  assert.equal(onlyTimeAgoChanged(original + "\n<!-- changed -->", valid), false);
});

test("rejects malformed or non-string source", () => {
  assert.equal(onlyTimeAgoChanged(null, valid), false);
  assert.equal(onlyTimeAgoChanged(original, undefined), false);
  assert.equal(onlyTimeAgoChanged("<script></script>", valid), false);
});
