import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { validateAgentPatch } from "./validate-local-agent-patch.mjs";

function string(value) {
  return typeof value === "string" ? value : "";
}

export function buildIndependentReview({ patch, summary, safety, baseSha, currentSha, qaStatus }) {
  const findings = [];
  const patchText = string(patch);
  const evidence = Array.isArray(summary?.evidence)
    ? summary.evidence.filter((item) => typeof item === "string" && item.trim()).slice(0, 8)
    : [];
  let staticValidation = null;
  try {
    staticValidation = validateAgentPatch(patchText, summary);
  } catch (error) {
    findings.push("Patch validation failed: " + String(error?.message || error).slice(0, 300));
  }

  const pathsMatch = staticValidation &&
    Array.isArray(safety?.paths) &&
    JSON.stringify([...safety.paths].sort()) === JSON.stringify([...staticValidation.paths].sort());
  const riskMatch = staticValidation &&
    safety?.requires_approval === staticValidation.requires_approval;
  const checks = {
    base_revision_matches: Boolean(baseSha && currentSha && baseSha === currentSha),
    evidence_backed_finding: summary?.finding_status === "issue_found" && evidence.length > 0,
    non_empty_patch: patchText.length > 0 && summary?.patch_available === true,
    path_and_risk_validation_repeated: Boolean(staticValidation && pathsMatch && riskMatch),
    independent_qa_passed: qaStatus === "passed",
  };

  if (!checks.base_revision_matches) findings.push("Tested base revision does not match the clean QA checkout.");
  if (!checks.evidence_backed_finding) findings.push("The model result is not an evidence-backed issue finding.");
  if (!checks.non_empty_patch) findings.push("No usable patch is available.");
  if (!checks.path_and_risk_validation_repeated) findings.push("The safety result does not match an independent validator run.");
  if (!checks.independent_qa_passed) findings.push("Independent regression QA did not pass.");

  const passed = Object.values(checks).every(Boolean) && findings.length === 0;
  return {
    schema_version: 1,
    reviewer_role: "independent_static_qa",
    conclusion: passed ? "pass_for_draft_pr" : "reject",
    checks,
    changed_paths: staticValidation?.paths || [],
    risk: string(summary?.risk) || "unknown",
    manual_approval_required: true,
    semantic_correctness: "not_independently_assessed",
    findings,
    limitations: [
      "No second AI model was used; this is an independent static and test-based review.",
      "Passing permits only preparation of a draft PR and does not establish semantic correctness.",
      "A human must review and approve before any merge or production change.",
    ],
  };
}

export function renderIndependentReview(report) {
  const status = report?.conclusion === "pass_for_draft_pr"
    ? "Проверки пройдены для подготовки чернового PR"
    : "Patch отклонён независимой проверкой";
  const checks = Object.entries(report?.checks || {})
    .map(([name, passed]) => "- **" + name + ":** " + (passed === true ? "пройдено" : "не пройдено"));
  const paths = Array.isArray(report?.changed_paths) && report.changed_paths.length
    ? report.changed_paths.join(", ")
    : "нет";
  return [
    "## Независимый автоматический Reviewer FAM",
    "",
    "- **Результат:** " + status,
    "- **Роль:** статическая и тестовая проверка; второй ИИ-рецензент не использовался",
    "- **Изменённые пути:** " + paths,
    "- **Оценка риска:** " + (report?.risk || "не оценён"),
    "- **Семантическая корректность:** отдельно не подтверждена",
    "- **Подтверждение человека перед merge:** обязательно",
    "",
    ...checks,
    "",
    "Этот отчёт не является одобрением merge или production deployment.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [patchPath, summaryPath, safetyPath, basePath, reportPath, markdownPath] = process.argv.slice(2);
  if (!patchPath || !summaryPath || !safetyPath || !basePath || !reportPath || !markdownPath) {
    throw new Error("Usage: node scripts/fam-agent-reviewer.mjs <patch> <summary.json> <safety.json> <base.sha> <review.json> <review.md>");
  }
  const patch = readFileSync(patchPath, "utf8");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const safety = JSON.parse(readFileSync(safetyPath, "utf8"));
  const baseSha = readFileSync(basePath, "utf8").trim();
  const currentSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const report = buildIndependentReview({
    patch, summary, safety, baseSha, currentSha,
    qaStatus: process.env.FAM_QA_STATUS || "",
  });
  const markdown = renderIndependentReview(report);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(markdownPath, markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  process.stdout.write(markdown);
  if (report.conclusion !== "pass_for_draft_pr") process.exitCode = 1;
}
