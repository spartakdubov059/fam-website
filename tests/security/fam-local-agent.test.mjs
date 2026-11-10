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

test("local agent only accepts website, docs and test paths", () => {
  assert.equal(isAllowedAgentPath("index.html"), true);
  assert.equal(isAllowedAgentPath("css/style.css"), true);
  assert.equal(isAllowedAgentPath("tests/security/example.test.mjs"), true);
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
