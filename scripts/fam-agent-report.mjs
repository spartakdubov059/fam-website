const FINDING_STATUSES = new Set(["no_issue", "needs_research", "blocked", "issue_found"]);
const RISKS = new Set(["low", "medium", "high"]);

function text(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, limit);
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => text(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function buildAgentReport(input = {}) {
  let findingStatus = FINDING_STATUSES.has(input.finding_status)
    ? input.finding_status
    : "needs_research";
  const patch = text(input.unified_diff, 120_000);
  const patchAvailable = patch.length > 0;
  const evidence = stringList(input.evidence, 8, 500);
  const problemSummary = text(input.problem_summary, 1200);

  if (findingStatus === "issue_found" && (!problemSummary || evidence.length === 0)) {
    findingStatus = "needs_research";
  }

  if (patchAvailable && findingStatus !== "issue_found") {
    throw new Error("A patch requires a reported, evidence-backed finding.");
  }

  const outcome = patchAvailable
    ? "patch_prepared"
    : findingStatus === "no_issue"
    ? "no_issue"
    : findingStatus === "blocked"
    ? "blocked"
    : "needs_research";
  const risk = RISKS.has(input.risk)
    ? input.risk
    : outcome === "no_issue"
    ? "low"
    : "high";
  const summary = text(input.summary, 1800) ||
    text(input.problem_summary, 1200) ||
    (outcome === "no_issue" ? "Модель не подтвердила конкретную проблему." : "Нужна дополнительная проверка.");

  return {
    schema_version: 1,
    outcome,
    finding_status: findingStatus,
    patch_available: patchAvailable,
    problem_found: findingStatus === "issue_found",
    summary,
    problem_summary: problemSummary,
    root_cause: text(input.root_cause, 1200),
    evidence,
    affected_files: stringList(input.selected_files ?? input.affected_files, 4, 200),
    proposed_change: text(input.proposed_change ?? input.plan, 1400),
    risk,
    requires_approval: !patchAvailable || risk !== "low" || input.requires_approval !== false,
    suggested_tests: stringList(input.tests ?? input.suggested_tests, 12, 300),
    verification_status: patchAvailable ? "pending" : "not_run_no_patch",
    model: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
  };
}

function markdownText(value, limit = 700) {
  return text(value, limit)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\(/g, "&#40;")
    .replace(/\)/g, "&#41;")
    .replace(/[|*_~#]/g, (character) => "&#" + character.charCodeAt(0) + ";");
}

export function renderAgentReport(report) {
  const outcomes = {
    patch_prepared: "Подготовлен patch; далее должны пройти проверки",
    no_issue: "Конкретная проблема не подтверждена; patch не создан",
    needs_research: "Есть сигнал, но доказательств или безопасного решения недостаточно",
    blocked: "Работа остановлена защитными ограничениями",
  };
  const outcome = outcomes[report?.outcome] || "Результат не распознан";
  const files = stringList(report?.affected_files, 4, 200);
  const evidence = stringList(report?.evidence, 8, 500);
  const tests = stringList(report?.suggested_tests, 12, 300);
  const lines = [
    "## Отчёт Qwen-разработчика FAM",
    "",
    "- **Результат:** " + outcome,
    "- **Проблема подтверждена:** " + (report?.problem_found === true ? "да" : "нет"),
    "- **Описание:** " + (markdownText(report?.problem_summary || report?.summary) || "не указано"),
    "- **Предполагаемая причина:** " + (markdownText(report?.root_cause) || "не указана"),
    "- **Файлы:** " + (files.length ? files.map((item) => markdownText(item, 200)).join(", ") : "не выбраны"),
    "- **Предложение:** " + (markdownText(report?.proposed_change, 1000) || "нет"),
    "- **Риск:** " + markdownText(report?.risk || "не оценён", 40),
    "- **Ручное подтверждение:** " + (report?.requires_approval === true ? "требуется" : "не требуется для создания PR"),
    "- **Проверка patch:** " + (report?.verification_status === "pending"
      ? "ожидает отдельного QA job"
      : report?.verification_status === "passed"
      ? "успешно прошла отдельный QA job"
      : "не запускалась: patch отсутствует"),
  ];

  if (evidence.length) {
    lines.push("", "**Доказательства модели:**", ...evidence.map((item) => "- " + markdownText(item, 500)));
  }
  if (tests.length) {
    lines.push("", "**Проверки, предложенные моделью (это не результат запуска):**", ...tests.map((item) => "- " + markdownText(item, 300)));
  }
  lines.push("", "Отчёт отражает вывод локальной модели; сам по себе он не подтверждает правильность диагноза или patch.", "");
  return lines.join("\n");
}
