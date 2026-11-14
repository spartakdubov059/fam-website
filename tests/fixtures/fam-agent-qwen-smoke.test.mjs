import assert from "node:assert/strict";
import test from "node:test";
import { calculateTotal } from "./fam-agent-qwen-smoke.mjs";

test("calculateTotal treats taxRate as a fraction", () => {
  assert.equal(calculateTotal(100, 0.08), 108);
});
