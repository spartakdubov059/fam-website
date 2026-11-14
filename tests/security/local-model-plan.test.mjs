import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlannerResponse } from "../../scripts/local-model-plan.mjs";

const tracked = ["tests/fixtures/qwen-model-benchmark.mjs"];

test("preserves a complete planner response", () => {
  const response = {
    finding_status: "issue_found",
    problem_summary: "Problem",
    root_cause: "Cause",
    evidence: ["line 1"],
    files: tracked,
    keywords: ["normalize"],
    plan: "Change one line",
  };

  assert.equal(normalizePlannerResponse(response, { trackedPaths: tracked }), response);
});

test("normalizes a schema-drifted patch only onto one explicit tracked file", () => {
  const response = {
    finding_status: "issue_found",
    problem_summary: "Whitespace is not collapsed.",
    root_cause: "Only trim is applied.",
    evidence: "tests/fixtures/qwen-model-benchmark.mjs:1-3",
    unified_diff: "@@ -1 +1 @@\n-old\n+new",
    risks: ["Low impact", "Potential side effects"],
    requires_approval: false,
    tests_to_run: ["tests/fixtures/qwen-model-benchmark.test.mjs"],
  };

  const plan = normalizePlannerResponse(response, {
    explicitPaths: tracked,
    trackedPaths: tracked,
  });

  assert.deepEqual(plan.files, tracked);
  assert.deepEqual(plan.evidence, ["tests/fixtures/qwen-model-benchmark.mjs:1-3"]);
  assert.equal(plan.plan, "Whitespace is not collapsed.");
  assert.equal(plan.risk, "low");
  assert.equal(plan.requires_approval, true);
  assert.deepEqual(plan.tests, ["tests/fixtures/qwen-model-benchmark.test.mjs"]);
});

test("rejects patch fallback without one explicit tracked allowlisted path", () => {
  const response = {
    finding_status: "issue_found",
    problem_summary: "Problem",
    evidence: ["evidence"],
    unified_diff: "@@ -1 +1 @@\n-old\n+new",
  };

  assert.equal(normalizePlannerResponse(response, { trackedPaths: tracked }), null);
  assert.equal(normalizePlannerResponse(response, { explicitPaths: ["../secret"], trackedPaths: tracked }), null);
  assert.equal(normalizePlannerResponse(response, { explicitPaths: ["docs/other.md"], trackedPaths: tracked }), null);
});

test("does not normalize empty or non-issue planner responses", () => {
  assert.equal(normalizePlannerResponse({ finding_status: "issue_found", unified_diff: "" }, { explicitPaths: tracked, trackedPaths: tracked }), null);
  assert.equal(normalizePlannerResponse({ finding_status: "needs_research", unified_diff: "@@ -1 +1 @@\n-old\n+new", evidence: ["evidence"] }, { explicitPaths: tracked, trackedPaths: tracked }), null);
});
