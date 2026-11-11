import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentReport, renderAgentReport } from "../../scripts/fam-agent-report.mjs";

test("no-patch runs preserve the model finding and say QA did not run", () => {
  const report = buildAgentReport({
    finding_status: "issue_found",
    problem_summary: "A list fails to load in one state.",
    root_cause: "The error branch does not clear the loading state.",
    evidence: ["js/listings.js:42 — loading stays true after rejection"],
    proposed_change: "Clear the loading state in the error handler.",
    selected_files: ["js/listings.js"],
    risk: "high",
    requires_approval: true,
    tests: ["Add a rejection-path regression test."],
    unified_diff: "",
  });

  assert.equal(report.outcome, "needs_research");
  assert.equal(report.patch_available, false);
  assert.equal(report.problem_found, true);
  assert.equal(report.verification_status, "not_run_no_patch");
  assert.equal(report.requires_approval, true);
  assert.deepEqual(report.affected_files, ["js/listings.js"]);
});

test("a patch cannot be reported without an evidence-backed issue", () => {
  assert.throws(() => buildAgentReport({
    finding_status: "no_issue",
    unified_diff: "diff --git a/docs/a.md b/docs/a.md",
  }), /evidence-backed finding/);

  const unsupported = buildAgentReport({
    finding_status: "issue_found",
    problem_summary: "The model suspects a defect.",
    evidence: [],
  });
  assert.equal(unsupported.outcome, "needs_research");
  assert.equal(unsupported.problem_found, false);
});

test("a no-issue result is explicit and does not claim tests ran", () => {
  const report = buildAgentReport({
    finding_status: "no_issue",
    summary: "No reproducible defect was found in the selected files.",
    proposed_change: "No change.",
  });

  assert.equal(report.outcome, "no_issue");
  assert.equal(report.patch_available, false);
  assert.equal(report.problem_found, false);
  assert.equal(report.verification_status, "not_run_no_patch");
  assert.equal(report.requires_approval, true);
});

test("the Actions report escapes model-controlled Markdown and labels proposed tests", () => {
  const report = buildAgentReport({
    finding_status: "issue_found",
    problem_summary: "<script>alert(1)</script> [untrusted](https://example.invalid)",
    root_cause: "A `code` value was copied from source.",
    evidence: ["index.html:7 | observed text"],
    proposed_change: "Patch pending.",
    selected_files: ["index.html"],
    risk: "medium",
    requires_approval: true,
    tests: ["node --test tests/example.test.mjs"],
    unified_diff: "diff --git a/index.html b/index.html",
  });
  const output = renderAgentReport(report);

  assert.match(output, /&lt;script&gt;/);
  assert.doesNotMatch(output, /\]\(https:\/\/example\.invalid\)/);
  assert.match(output, /Проверки, предложенные моделью \(это не результат запуска\)/);
  assert.match(output, /ожидает отдельного QA job/);

  report.verification_status = "passed";
  assert.match(renderAgentReport(report), /успешно прошла отдельный QA job/);
});
