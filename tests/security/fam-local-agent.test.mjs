import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPatchPaths,
  isAllowedAgentPath,
  requiresManualApproval,
  validateAgentPatch,
} from "../../scripts/validate-local-agent-patch.mjs";

const validPatch = [
  "diff --git a/index.html b/index.html",
  "index 1111111..2222222 100644",
  "--- a/index.html",
  "+++ b/index.html",
  "@@ -1 +1 @@",
  "-<title>Old</title>",
  "+<title>New</title>",
].join("\n");

function jsPatch(change) {
  return [
    "diff --git a/js/app.js b/js/app.js",
    "index 1111111..2222222 100644",
    "--- a/js/app.js",
    "+++ b/js/app.js",
    "@@ -1 +1 @@",
    "-const label = 'Old';",
    "+const label = '" + change + "';",
  ].join("\n");
}

test("local agent only accepts website, docs and test paths", () => {
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
  assert.deepEqual(extractPatchPaths(validPatch), ["index.html"]);
  const rename = validPatch.replace(
    "diff --git a/index.html b/index.html",
    "diff --git a/index.html b/css/new.html",
  );
  assert.throws(() => extractPatchPaths(rename), /Rename patches/);
});

test("critical or uncertain model output always requires human approval", () => {
  assert.equal(requiresManualApproval({ risk: "low", requires_approval: false }, validPatch), false);
  assert.equal(requiresManualApproval({ risk: "medium", requires_approval: false }, validPatch), true);
  assert.equal(requiresManualApproval({ risk: "low", requires_approval: true }, validPatch), true);
  assert.equal(
    requiresManualApproval(
      { risk: "low", requires_approval: false },
      validPatch + "\n+// account_deletion workflow",
    ),
    true,
  );
  assert.equal(
    requiresManualApproval(
      { risk: "low", requires_approval: false },
      jsPatch("read user profile"),
    ),
    true,
  );
  assert.equal(
    requiresManualApproval(
      { risk: "low", requires_approval: false },
      jsPatch("toggle a simple visual hint"),
    ),
    false,
  );
});

test("CSS-only visual updates can be automated without bypassing critical backend boundaries", () => {
  const cssPatch = [
    "diff --git a/css/style.css b/css/style.css",
    "index 1111111..2222222 100644",
    "--- a/css/style.css",
    "+++ b/css/style.css",
    "@@ -1 +1 @@",
    "-.card { border-radius: 8px; }",
    "+.card { border-radius: 14px; }",
  ].join("\n");
  assert.equal(requiresManualApproval({ risk: "low", requires_approval: false }, cssPatch), false);
});

test("validator rejects forbidden paths and approves only verified low-risk diffs", () => {
  assert.deepEqual(
    validateAgentPatch(validPatch, { risk: "low", requires_approval: false }),
    { paths: ["index.html"], requires_approval: false },
  );
  const forbidden = validPatch.replaceAll("index.html", "supabase/migrations/unsafe.sql");
  assert.throws(
    () => validateAgentPatch(forbidden, { risk: "low", requires_approval: false }),
    /outside the FAM agent allowlist/,
  );
});
