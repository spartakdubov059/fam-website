import test from "node:test";
import assert from "node:assert/strict";
import { isValidNoPatchReport } from "../../scripts/validate-local-agent-no-patch.mjs";

const validReport = {
  outcome: "needs_research",
  finding_status: "needs_research",
  patch_available: false,
  problem_found: false,
  verification_status: "not_run_no_patch",
  root_cause: "The model could not cite the selected source line.",
  evidence: [],
};

test("accepts an honest fail-closed no-patch report", () => {
  assert.equal(isValidNoPatchReport(validReport), true);
});

test("accepts blocked reports and rejects inconsistent or unsafe report states", () => {
  assert.equal(isValidNoPatchReport({ ...validReport, outcome: "blocked", finding_status: "blocked" }), true);
  assert.equal(isValidNoPatchReport({ ...validReport, patch_available: true }), false);
  assert.equal(isValidNoPatchReport({ ...validReport, problem_found: true }), false);
  assert.equal(isValidNoPatchReport({ ...validReport, finding_status: "issue_found" }), false);
  assert.equal(isValidNoPatchReport({ ...validReport, verification_status: "passed" }), false);
  assert.equal(isValidNoPatchReport({ ...validReport, root_cause: "  " }), false);
  assert.equal(isValidNoPatchReport({ ...validReport, evidence: ["invented evidence"] }), false);
  assert.equal(isValidNoPatchReport(null), false);
});
