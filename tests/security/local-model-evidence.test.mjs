import assert from "node:assert/strict";
import test from "node:test";
import { verifyModelEvidence } from "../../scripts/local-model-evidence.mjs";

const sources = {
  "js/example.js": "function value() {\n  return 0;\n}\n",
};

test("model evidence must cite an exact line from a selected source file", () => {
  assert.deepEqual(
    verifyModelEvidence(["js/example.js:2:   return 0;"], sources),
    ["js/example.js:2: return 0;"],
  );
});

test("model evidence rejects invented paths, lines, and source text", () => {
  assert.deepEqual(
    verifyModelEvidence([
      "docs/missing.md:1: invented",
      "js/example.js:99: return 0;",
      "js/example.js:2: return 1;",
      "js/example.js:0: function value() {",
      "not a source reference",
    ], sources),
    [],
  );
});

test("model evidence is bounded and duplicate citations are removed", () => {
  const entries = [
    "js/example.js:1: function value() {",
    "js/example.js:1: function value() {",
    ...Array.from({ length: 10 }, (_, index) => `js/example.js:${index + 1}: ${sources["js/example.js"].split("\n")[index] || "missing"}`),
  ];
  const verified = verifyModelEvidence(entries, sources);
  assert.equal(verified.length, 3);
  assert.equal(new Set(verified).size, verified.length);
});
