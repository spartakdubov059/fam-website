import test from "node:test";
import assert from "node:assert/strict";
import { buildIndependentReview, renderIndependentReview } from "../../scripts/fam-agent-reviewer.mjs";
import { validateAgentPatch } from "../../scripts/validate-local-agent-patch.mjs";

const patch = [
  "diff --git a/js/example.js b/js/example.js",
  "--- a/js/example.js",
  "+++ b/js/example.js",
  "@@ -1 +1 @@",
  "-return amount + taxRate;",
  "+return amount * (1 + taxRate);",
].join("\n");
const summary = {
  finding_status: "issue_found",
  patch_available: true,
  risk: "medium",
  evidence: ["The calculation treats a fractional rate as a fixed amount."],
};
const safety = validateAgentPatch(patch, summary);

test("independent reviewer permits only a verified draft PR and states its limits", () => {
  const report = buildIndependentReview({
    patch, summary, safety, baseSha: "abc123", currentSha: "abc123", qaStatus: "passed",
  });
  assert.equal(report.conclusion, "pass_for_draft_pr");
  assert.equal(report.reviewer_role, "independent_static_qa");
  assert.equal(report.manual_approval_required, true);
  assert.equal(report.semantic_correctness, "not_independently_assessed");
  assert.deepEqual(report.changed_paths, ["js/example.js"]);
  const markdown = renderIndependentReview(report);
  assert.match(markdown, /второй ИИ-рецензент не использовался/);
  assert.match(markdown, /не является одобрением merge/);
});

test("reviewer rejects a non-matching base and failed QA", () => {
  const report = buildIndependentReview({
    patch, summary, safety, baseSha: "old", currentSha: "new", qaStatus: "failed",
  });
  assert.equal(report.conclusion, "reject");
  assert.equal(report.checks.base_revision_matches, false);
  assert.equal(report.checks.independent_qa_passed, false);
  assert.equal(report.manual_approval_required, true);
});

test("reviewer repeats allowlist validation and rejects mismatched safety output", () => {
  const report = buildIndependentReview({
    patch, summary, safety: { ...safety, paths: ["supabase/migrations/unsafe.sql"] },
    baseSha: "abc123", currentSha: "abc123", qaStatus: "passed",
  });
  assert.equal(report.conclusion, "reject");
  assert.equal(report.checks.path_and_risk_validation_repeated, false);
});

test("reviewer rejects a patch without evidence", () => {
  const report = buildIndependentReview({
    patch, summary: { ...summary, evidence: [] }, safety,
    baseSha: "abc123", currentSha: "abc123", qaStatus: "passed",
  });
  assert.equal(report.conclusion, "reject");
  assert.equal(report.checks.evidence_backed_finding, false);
});
