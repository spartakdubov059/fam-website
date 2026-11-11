import { appendFileSync, readFileSync } from "node:fs";
import { renderAgentReport } from "./fam-agent-report.mjs";

const [reportPath, summaryPath = process.env.GITHUB_STEP_SUMMARY, verificationStatus] = process.argv.slice(2);
if (!reportPath) throw new Error("Usage: node scripts/render-fam-agent-report.mjs <report.json> [summary.md]");

const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (verificationStatus !== undefined) {
  if (verificationStatus !== "passed" || report.patch_available !== true) {
    throw new Error("Only a verified patch may be marked as passed.");
  }
  report.verification_status = "passed";
}
const markdown = renderAgentReport(report);
if (summaryPath) appendFileSync(summaryPath, markdown, "utf8");
else process.stdout.write(markdown);
