import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractPatchPaths, isAllowedAgentPath } from "./validate-local-agent-patch.mjs";

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|access[_-]?token|service[_-]?role)\s*[:=]\s*["'`][A-Za-z0-9_./+=-]{16,}["'`]/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sb_secret_[A-Za-z0-9_-]{16,})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const BLOCKED_ACTIVE_PATTERNS = [
  /<\s*script\b/i,
  /\bon[a-z][a-z0-9_-]*\s*=/i,
  /javascript\s*:/i,
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /\bdocument\.write\s*\(/i,
];
const REVIEW_PATTERNS = [
  { name: "dynamic_html_sink", pattern: /\b(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/i },
  { name: "outbound_network_change", pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/i },
  { name: "credential_or_session_access", pattern: /\bdocument\.cookie\b|localStorage\.(?:getItem|setItem)\s*\(\s*["'][^"']*(?:token|auth|session)/i },
  { name: "external_style_resource", pattern: /@import\b|url\(\s*["']?\s*(?:https?:)?\/\//i },
];

function changedLines(patch) {
  const result = [];
  let path = "";
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) { path = header[1]; continue; }
    if (/^diff --git /.test(line)) { path = line.match(/^diff --git a\/(.+?) b\//)?.[1] || ""; continue; }
    if (/^\+(?!\+)/.test(line)) result.push({ path, text: line.slice(1) });
  }
  return result;
}

export function buildSecurityReport(patch) {
  const findings = [];
  let paths = [];
  try {
    paths = extractPatchPaths(patch);
  } catch {
    findings.push({ severity: "blocker", code: "invalid_patch", path: null });
  }
  for (const path of paths) {
    if (!isAllowedAgentPath(path)) findings.push({ severity: "blocker", code: "path_outside_allowlist", path });
  }

  const additions = changedLines(patch);
  for (const { path, text } of additions) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      findings.push({ severity: "blocker", code: "possible_secret_literal", path });
      continue;
    }
    if ((path === "index.html" || path.startsWith("js/")) &&
        BLOCKED_ACTIVE_PATTERNS.some((pattern) => pattern.test(text))) {
      findings.push({ severity: "blocker", code: "active_or_dynamic_execution", path });
      continue;
    }
    if ((path === "index.html" || path.startsWith("js/") || path.startsWith("css/")) &&
        REVIEW_PATTERNS.some(({ pattern }) => pattern.test(text))) {
      const code = REVIEW_PATTERNS.find(({ pattern }) => pattern.test(text))?.name || "sensitive_runtime_change";
      findings.push({ severity: "review", code, path });
    }
  }

  const unique = [...new Map(findings.map((finding) =>
    [finding.severity + ":" + finding.code + ":" + finding.path, finding],
  )).values()];
  const hasBlocker = unique.some((finding) => finding.severity === "blocker");
  return {
    schema_version: 1,
    agent_role: "security_static_analysis",
    conclusion: hasBlocker ? "reject" : unique.length ? "review_required" : "no_static_finding",
    changed_paths: paths,
    findings: unique,
    manual_approval_required: true,
    limitations: [
      "This is a static review of added patch lines; it does not prove the whole application is secure.",
      "Supabase RLS, Auth, secrets, dependencies, and production configuration are outside this patch-only scan.",
      "No AI model was used; flagged cases require a human security review.",
    ],
  };
}

export function renderSecurityReport(report) {
  const labels = {
    reject: "Patch отклонён: обнаружен блокирующий security сигнал",
    review_required: "Требуется ручная security проверка",
    no_static_finding: "Статические правила не обнаружили сигналов",
  };
  const findings = report.findings.length
    ? report.findings.map((item) => "- **" + item.severity + ":** " + item.code + " (" + item.path + ")")
    : ["- Новых статических security сигналов не найдено."];
  return [
    "## Security Agent FAM — статический отчёт",
    "",
    "- **Результат:** " + (labels[report.conclusion] || "не распознан"),
    "- **Пути:** " + (report.changed_paths.join(", ") || "не указаны"),
    "- **Подтверждение человека перед merge:** обязательно",
    "",
    ...findings,
    "",
    "Проверка ограничена добавленными строками patch и не заменяет аудит runtime, RLS, Auth или production.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [patchPath, reportPath, markdownPath] = process.argv.slice(2);
  if (!patchPath || !reportPath || !markdownPath) {
    throw new Error("Usage: node scripts/fam-agent-security.mjs <patch> <security.json> <security.md>");
  }
  const report = buildSecurityReport(readFileSync(patchPath, "utf8"));
  const markdown = renderSecurityReport(report);
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(markdownPath, markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  process.stdout.write(markdown);
  if (report.conclusion === "reject") process.exitCode = 1;
}
