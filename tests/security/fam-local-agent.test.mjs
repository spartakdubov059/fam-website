import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPatchPaths,
  isAllowedAgentPath,
  requiresManualApproval,
  validateAgentPatch,
} from "../../scripts/validate-local-agent-patch.mjs";

const lowRisk = { risk: "low", requires_approval: false };

const validPatch = [
  "diff --git a/docs/help.md b/docs/help.md",
  "index 1111111..2222222 100644",
  "--- a/docs/help.md",
  "+++ b/docs/help.md",
  "@@ -1 +1 @@",
  "-Old help text",
  "+New help text",
].join("\n");

function filePatch(path, oldLine, newLine) {
  return [
    "diff --git a/" + path + " b/" + path,
    "index 1111111..2222222 100644",
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1 +1 @@",
    "-" + oldLine,
    "+" + newLine,
  ].join("\n");
}

test("local agent only accepts website, docs and safe test paths", () => {
  assert.equal(isAllowedAgentPath("index.html"), true);
  assert.equal(isAllowedAgentPath("css/style.css"), true);
  assert.equal(isAllowedAgentPath("js/app.js"), true);
  assert.equal(isAllowedAgentPath("tests/security/example.test.mjs"), true);
  assert.equal(isAllowedAgentPath("assets/banner.webp"), true);
  assert.equal(isAllowedAgentPath("assets/vector.svg"), false);
  for (const path of [
    ".github/workflows/build.yml",
    "scripts/run-local-coder.mjs",
    "supabase/migrations/unsafe.sql",
    "supabase/functions/moderate/index.ts",
    "../outside.txt",
    "/etc/passwd",
  ]) {
    assert.equal(isAllowedAgentPath(path), false, path);
  }
});

test("patch parser extracts exact git diff paths and rejects renames", () => {
  assert.deepEqual(extractPatchPaths(validPatch), ["docs/help.md"]);
  const rename = validPatch.replace(
    "diff --git a/docs/help.md b/docs/help.md",
    "diff --git a/docs/help.md b/css/new.html",
  );
  assert.throws(() => extractPatchPaths(rename), /Rename patches/);
});

test("docs-only changes can be automated after independent verification", () => {
  assert.equal(requiresManualApproval(lowRisk, validPatch), false);
  assert.deepEqual(validateAgentPatch(validPatch, lowRisk), {
    paths: ["docs/help.md"],
    requires_approval: false,
  });
});

test("CSS visual changes can be automated, but external resources need review", () => {
  const safeCss = filePatch("css/style.css", ".card { padding: 8px; }", ".card { padding: 12px; }");
  const remoteCss = filePatch("css/style.css", ".card { padding: 8px; }", "@import url('https://example.com/a.css');");
  assert.equal(requiresManualApproval(lowRisk, safeCss), false);
  assert.equal(requiresManualApproval(lowRisk, remoteCss), true);
});

test("HTML, JavaScript and test-suite changes always require review", () => {
  assert.equal(requiresManualApproval(lowRisk, filePatch("js/app.js", "const a = 1;", "const a = 2;")), true);
  assert.equal(requiresManualApproval(lowRisk, filePatch("index.html", "<title>Old</title>", "<title>New</title>")), true);
  assert.equal(requiresManualApproval(lowRisk, filePatch("tests/security/test.mjs", "assert.ok(true);", "assert.ok(false);")), true);
});

test("critical output or active HTML content requires manual approval", () => {
  assert.equal(
    requiresManualApproval(lowRisk, filePatch("index.html", "<p>Old</p>", "<script>alert(1)</script>")),
    true,
  );
  assert.equal(
    requiresManualApproval(lowRisk, filePatch("css/style.css", ".a { color: red; }", ".a { background: url(https://example.com/x); }")),
    true,
  );
  assert.equal(
    requiresManualApproval({ risk: "medium", requires_approval: false }, validPatch),
    true,
  );
  assert.equal(
    requiresManualApproval({ risk: "low", requires_approval: true }, validPatch),
    true,
  );
});

test("validator rejects forbidden paths and approves only verified low-risk diffs", () => {
  const forbidden = validPatch.replaceAll("docs/help.md", "supabase/migrations/unsafe.sql");
  assert.throws(
    () => validateAgentPatch(forbidden, lowRisk),
    /outside the FAM agent allowlist/,
  );
});
