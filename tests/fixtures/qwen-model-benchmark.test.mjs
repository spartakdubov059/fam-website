import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSearchInput } from "./qwen-model-benchmark.mjs";

test("normalizes case and collapses internal whitespace", () => {
  assert.equal(
    normalizeSearchInput("  FAM\t  Свои\nрядом  "),
    "fam свои рядом",
  );
});

test("collapses Unicode whitespace runs to one regular space", () => {
  assert.equal(
    normalizeSearchInput("УЧЁБА\u00a0\u00a0и\t\tтворчество\nрядом"),
    "учёба и творчество рядом",
  );
});

test("handles nullish input", () => {
  assert.equal(normalizeSearchInput(null), "");
  assert.equal(normalizeSearchInput(undefined), "");
});
