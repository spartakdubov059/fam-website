import { readFileSync } from "node:fs";

const acceptedStatuses = new Set(["needs_research", "blocked"]);

export function isValidNoPatchReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  return acceptedStatuses.has(report.outcome) &&
    report.finding_status === report.outcome &&
    report.patch_available === false &&
    report.problem_found === false &&
    report.verification_status === "not_run_no_patch" &&
    typeof report.root_cause === "string" && report.root_cause.trim().length > 0 &&
    Array.isArray(report.evidence) && report.evidence.length === 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error("Usage: node validate-local-agent-no-patch.mjs <summary.json>");
    process.exit(2);
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!isValidNoPatchReport(report)) {
      console.error("No-patch report is missing a valid fail-closed status or reason");
      process.exit(1);
    }
  } catch (error) {
    console.error(`No-patch report is invalid: ${error.message}`);
    process.exit(1);
  }
}
