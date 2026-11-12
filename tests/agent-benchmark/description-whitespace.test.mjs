import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const start = html.indexOf("  function normalizeDescriptionForEditor(");
const end = html.indexOf("\n\n  function makeDescriptionTemplate()", start);
assert.ok(start >= 0 && end > start, "normalizeDescriptionForEditor source must be present in index.html");

const functionSource = html.slice(start, end).trim();
const normalizeDescriptionForEditor = vm.runInNewContext("(" + functionSource + ")");

test("description editor collapses Unicode space separators to one ordinary space", () => {
  const input = "  новый\u00a0\u00a0VR\u202fшлем\u2009для\u3000учёбы  ";
  assert.equal(
    normalizeDescriptionForEditor(input),
    "Новый VR шлем для учёбы.",
  );
});

test("description editor keeps intentional line breaks while normalizing each line", () => {
  assert.equal(
    normalizeDescriptionForEditor("новый\u00a0шлем\nполная\u202fкомплектация"),
    "Новый шлем.\nПолная комплектация.",
  );
});
