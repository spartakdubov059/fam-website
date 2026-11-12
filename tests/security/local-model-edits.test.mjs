import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTextEdits,
  extractExplicitTargetPaths,
} from "../../scripts/local-model-edits.mjs";

const tracked = [
  "index.html",
  "js/app.js",
  "tests/fixtures/example.mjs",
  "tests/fixtures/example.test.mjs",
  "scripts/private.mjs",
];

function allowed(path) {
  return path === "index.html" || /^(?:css|js|assets|docs|tests)\//.test(path);
}

test("explicit Russian target skips unrelated referenced test files", () => {
  assert.deepEqual(
    extractExplicitTargetPaths(
      "Исправь дефект. Измени только tests/fixtures/example.mjs, не меняй tests/fixtures/example.test.mjs.",
      tracked,
      allowed,
    ),
    ["tests/fixtures/example.mjs"],
  );
});

test("explicit English target is recognised", () => {
  assert.deepEqual(
    extractExplicitTargetPaths("Fix the bug. Edit only js/app.js.", tracked, allowed),
    ["js/app.js"],
  );
});

test("unavailable and forbidden paths are not selected", () => {
  assert.deepEqual(
    extractExplicitTargetPaths("Измени только scripts/private.mjs.", tracked, allowed),
    [],
  );
  assert.deepEqual(
    extractExplicitTargetPaths("Измени только js/missing.js.", tracked, allowed),
    [],
  );
});

test("tasks without an explicit edit-only target keep normal planning", () => {
  assert.deepEqual(
    extractExplicitTargetPaths("Проведи аудит js/app.js и предложи улучшения.", tracked, allowed),
    [],
  );
});

test("applies exact, unique edits without requiring a model-generated diff", () => {
  const source = new Map([["js/app.js", "const title = 'Old';\nconst ready = true;\n"]]);
  const updated = applyTextEdits(
    source,
    [{ path: "js/app.js", find: "const title = 'Old';", replace: "const title = 'New';" }],
    ["js/app.js"],
  );
  assert.equal(updated.get("js/app.js"), "const title = 'New';\nconst ready = true;\n");
  assert.equal(source.get("js/app.js"), "const title = 'Old';\nconst ready = true;\n");
});

test("supports ordered edits to more than one selected file", () => {
  const source = new Map([
    ["js/app.js", "const title = 'Old';\n"],
    ["docs/help.md", "Old heading\n"],
  ]);
  const updated = applyTextEdits(source, [
    { path: "js/app.js", find: "const title = 'Old';", replace: "const title = 'New';" },
    { path: "docs/help.md", find: "Old heading", replace: "New heading" },
  ], ["js/app.js", "docs/help.md"]);
  assert.equal(updated.get("js/app.js"), "const title = 'New';\n");
  assert.equal(updated.get("docs/help.md"), "New heading\n");
});

test("rejects missing or ambiguous source fragments", () => {
  const source = new Map([["js/app.js", "const x = 1;\nconst x = 1;\n"]]);
  assert.throws(
    () => applyTextEdits(source, [{ path: "js/app.js", find: "missing", replace: "x" }], ["js/app.js"]),
    /not found/,
  );
  assert.throws(
    () => applyTextEdits(source, [{ path: "js/app.js", find: "const x = 1;", replace: "const x = 2;" }], ["js/app.js"]),
    /ambiguous/,
  );
});

test("rejects edits outside the selected file allowlist", () => {
  const source = new Map([["js/app.js", "const x = 1;\n"]]);
  assert.throws(
    () => applyTextEdits(source, [{ path: "scripts/private.mjs", find: "const x = 1;", replace: "const x = 2;" }], ["js/app.js"]),
    /not selected/,
  );
});

test("rejects empty and no-op edit payloads", () => {
  const source = new Map([["js/app.js", "const x = 1;\n"]]);
  assert.throws(() => applyTextEdits(source, [], ["js/app.js"]), /between 1 and 16/);
  assert.throws(
    () => applyTextEdits(source, [{ path: "js/app.js", find: "const x = 1;", replace: "const x = 1;" }], ["js/app.js"]),
    /does not change/,
  );
});


test("large untouched selected files do not count against changed output size", () => {
  const largeSource = "x".repeat(300000);
  const source = new Map([
    ["index.html", largeSource],
    ["docs/help.md", "Old heading\n"],
  ]);
  const updated = applyTextEdits(
    source,
    [{ path: "docs/help.md", find: "Old heading", replace: "New heading" }],
    ["index.html", "docs/help.md"],
  );
  assert.equal(updated.get("index.html"), largeSource);
  assert.equal(updated.get("docs/help.md"), "New heading\n");
});
