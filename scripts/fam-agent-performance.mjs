import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractPatchPaths } from "./validate-local-agent-patch.mjs";

function patchLines(patch) {
  const added = [];
  const removed = [];
  let path = "";
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) { path = line.slice(6); continue; }
    if (line.startsWith("diff --git ")) {
      path = line.match(/^diff --git a\/(.+?) b\//)?.[1] || "";
      continue;
    }
    if (/^\+(?!\+)/.test(line)) added.push({ path, text: line.slice(1) });
    else if (/^-(?!-)/.test(line)) removed.push({ path, text: line.slice(1) });
  }
  return { added, removed };
}

export function buildPerformanceReport(patch) {
  let paths = [];
  let invalidPatch = false;
  try { paths = extractPatchPaths(patch); } catch { invalidPatch = true; }
  const { added, removed } = patchLines(patch);
  const executable = (path) => path === "index.html" || /\.(?:m?js|css)$/i.test(path);
  const executableBytes = added
    .filter(({ path }) => executable(path))
    .reduce((total, { text }) => total + Buffer.byteLength(text, "utf8"), 0);
  const unbounded = added.filter(({ text }) => /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/i.test(text));
  const loopSites = added.filter(({ text }) => /\b(?:for|while)\s*\(|\.(?:forEach|map|filter)\s*\(/.test(text));
  const networkInIteration = added.filter(({ text }) =>
    /\b(?:fetch|XMLHttpRequest|sendBeacon)\b/.test(text) &&
    /\b(?:for|while)\s*\(|\.(?:forEach|map|filter)\s*\(/.test(text),
  );
  const domInIteration = added.filter(({ text }) =>
    /\b(?:querySelector(?:All)?|getElementById|getElementsByClassName)\s*\(/.test(text) &&
    /\b(?:for|while)\s*\(|\.(?:forEach|map|filter)\s*\(/.test(text),
  );
  const externalResources = added.filter(({ path, text }) =>
    (path === "index.html" || path.startsWith("css/")) &&
    /@import\b|url\(\s*["']?\s*(?:https?:)?\/\//i.test(text),
  );
  const binaryAssetChanges = (patch.match(/^Binary files .* differ$/gm) || []).length;
  const findings = [];
  if (invalidPatch) findings.push({ severity: "blocker", code: "invalid_patch" });
  if (unbounded.length) findings.push({ severity: "blocker", code: "unbounded_loop", count: unbounded.length });
  if (networkInIteration.length) findings.push({ severity: "review", code: "network_call_inside_iteration", count: networkInIteration.length });
  if (domInIteration.length) findings.push({ severity: "review", code: "dom_query_inside_iteration", count: domInIteration.length });
  if (externalResources.length) findings.push({ severity: "review", code: "external_resource_added", count: externalResources.length });

  const blocker = findings.some((finding) => finding.severity === "blocker");
  return {
    schema_version: 1,
    agent_role: "static_performance_analysis",
    conclusion: blocker ? "reject" : findings.length ? "review_required" : "no_static_hotspot",
    changed_paths: paths,
    metrics: {
      added_lines: added.length,
      removed_lines: removed.length,
      added_executable_bytes: executableBytes,
      loop_sites: loopSites.length,
      external_resources_added: externalResources.length,
      binary_asset_changes: binaryAssetChanges,
    },
    findings,
    runtime_measurement: "not_performed",
    mobile_measurement: "not_performed",
    limitations: [
      "Static indicators do not replace browser profiling or real-device measurements.",
      "Loop and DOM signals are line-based heuristics and can miss multi-line behavior.",
      "No schema or index changes were proposed by this report.",
    ],
  };
}

export function renderPerformanceReport(report) {
  const labels = {
    reject: "Есть блокирующий сигнал возможной бесконечной работы",
    review_required: "Нужна ручная проверка производительности",
    no_static_hotspot: "Статические эвристики не нашли очевидных hotspot",
  };
  const m = report.metrics;
  const findings = report.findings.length
    ? report.findings.map((item) => "- **" + item.severity + ":** " + item.code + " (" + item.count + ")")
    : ["- Очевидных статических hotspot не найдено."];
  return [
    "## Performance Agent FAM — статический отчёт",
    "",
    "- **Результат:** " + (labels[report.conclusion] || "не распознан"),
    "- **Изменённые пути:** " + (report.changed_paths.join(", ") || "не указаны"),
    "- **Добавлено/удалено строк:** " + m.added_lines + " / " + m.removed_lines,
    "- **Добавлено байт HTML/JS/CSS:** " + m.added_executable_bytes,
    "- **Найдено loop sites:** " + m.loop_sites,
    "- **Добавлено внешних ресурсов:** " + m.external_resources_added,
    "- **Изменения binary assets:** " + m.binary_asset_changes,
    "- **Измерение браузера/мобильных устройств:** не выполнялось",
    "",
    ...findings,
    "",
    "Отчёт использует статические эвристики; он не подтверждает фактическую скорость сайта.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [patchPath, reportPath, markdownPath] = process.argv.slice(2);
  if (!patchPath || !reportPath || !markdownPath) {
    throw new Error("Usage: node scripts/fam-agent-performance.mjs <patch> <performance.json> <performance.md>");
  }
  const report = buildPerformanceReport(readFileSync(patchPath, "utf8"));
  const markdown = renderPerformanceReport(report);
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(markdownPath, markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  process.stdout.write(markdown);
  if (report.conclusion === "reject") process.exitCode = 1;
}
