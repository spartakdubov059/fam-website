import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIMITS = Object.freeze({ lcp_ms: 4_000, cls: 0.25, tbt_ms: 600 });

function metric(report, auditId) {
  const value = report?.audits?.[auditId]?.numericValue;
  if (!Number.isFinite(value) || value < 0) throw new Error("missing_lighthouse_metric:" + auditId);
  return value;
}

export function summarizeFAMMobileLighthouse(report) {
  const score = report?.categories?.performance?.score;
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("missing_lighthouse_performance_score");
  }
  const result = {
    performance_score: Math.round(score * 100),
    lcp_ms: Math.round(metric(report, "largest-contentful-paint")),
    cls: Number(metric(report, "cumulative-layout-shift").toFixed(3)),
    tbt_ms: Math.round(metric(report, "total-blocking-time")),
    total_byte_weight_bytes: Math.round(metric(report, "total-byte-weight")),
    findings: [],
  };
  if (result.lcp_ms > LIMITS.lcp_ms) result.findings.push("LCP выше 4 секунд (плохая lab-категория Lighthouse).");
  if (result.cls > LIMITS.cls) result.findings.push("CLS выше 0.25 (плохая lab-категория Lighthouse).");
  if (result.tbt_ms > LIMITS.tbt_ms) result.findings.push("TBT выше 600 мс (плохая mobile-категория Lighthouse).");
  return result;
}

export function renderFAMMobileLighthouseSummary(result) {
  const lines = [
    "## Мобильная производительность FAM — Lighthouse lab run",
    "",
    "- Performance score: " + result.performance_score + "/100",
    "- LCP: " + result.lcp_ms + " мс",
    "- CLS: " + result.cls,
    "- TBT: " + result.tbt_ms + " мс (лабораторный proxy интерактивности; это не INP)",
    "- Общий объём загруженных байтов по Lighthouse: " + result.total_byte_weight_bytes,
    "- Условия: mobile emulation на GitHub-hosted runner; один lab run, не полевые данные и не p75 реальных пользователей.",
    "",
    ...(result.findings.length ? ["### Превышения", "", ...result.findings.map((item) => "- " + item)] : ["Пороговые превышения не обнаружены."]),
    "",
  ];
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error("lighthouse_report_path_required");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const result = summarizeFAMMobileLighthouse(report);
  const summary = renderFAMMobileLighthouseSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  process.stdout.write(summary);
  if (result.findings.length) process.exitCode = 1;
}
