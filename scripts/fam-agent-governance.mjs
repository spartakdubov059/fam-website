import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildIntegrationPlan, formatIntegrationPlan } from "./fam-integration-coordinator.mjs";
import { enqueueInspectorTask, fetchAgentMetrics, fetchDevelopmentAdvisorSnapshots, fetchLegalEvidenceSummary, fetchModerationSummary, fetchQueueHealth, inspectQueueHealth, mapInspectorWarning, validateLegalEvidenceSummaryResponse } from "./fam-governance-bridge.mjs";
import { buildDevelopmentAdvisor, renderDevelopmentAdvisor } from "./fam-development-advisor.mjs";
import { renderStaffSnapshot } from "./fam-agent-staff-snapshot.mjs";

export const REPORT_MARKER = "<!-- fam-governance-control-tower-v1 -->";
const DAY = 86_400_000;
const MAX_PRS = 25;
const CORE_WORKFLOW = "fam-codex-developer.yml";
const CODER_JOB = "Локальная модель готовит исправление";

export function summarizeQwenRuns(runs = []) {
  const rows = [];
  for (const run of runs) {
    const job = (run.jobs || []).find((item) => item.name === CODER_JOB);
    if (!job) continue;
    const duration = Math.max(0, dateMs(job.completed_at || run.updated_at) - dateMs(job.started_at || run.created_at));
    const modelOutcome = (job.steps || []).find((step) => step.name === "Запустить локальную модель и подготовить patch")?.conclusion;
    const preflight = (job.steps || []).find((step) => step.name === "Проверить настройки затрат до сборки модели");
    const modelDownload = (job.steps || []).find((step) => step.name === "Скачать бесплатную модель с лицензией Apache 2.0");
    const noTask = preflight?.conclusion === "success" && modelDownload?.conclusion === "skipped";
    const verifyJob = (run.jobs || []).find((item) => item.name === "Независимая проверка без модели и секретов");
    rows.push({
      status: job.conclusion || job.status || run.conclusion || run.status || "unknown",
      duration_ms: duration,
      no_task: noTask,
      model_outcome: modelOutcome || "not_run",
      generated: modelOutcome === "success" && verifyJob?.conclusion !== "skipped" && Boolean(verifyJob),
      qa_passed: verifyJob?.conclusion === "success",
      pr_created: (run.jobs || []).some((item) => item.name === "Подготовить PR и проверить исправление без публикации" && item.conclusion === "success"),
      estimated_runner_minutes: (run.jobs || []).reduce((sum, item) => {
        const milliseconds = Math.max(0, dateMs(item.completed_at || run.updated_at) - dateMs(item.started_at || run.created_at));
        return sum + Math.ceil(milliseconds / 60_000);
      }, 0),
    });
  }
  const count = (predicate) => rows.filter(predicate).length;
  const sorted = rows.map((row) => row.duration_ms).sort((a, b) => a - b);
  return Object.freeze({
    runs: rows.length,
    successful: count((row) => row.status === "success"),
    failed: count((row) => row.status === "failure"),
    no_task: count((row) => row.no_task),
    model_generated: count((row) => row.generated),
    model_no_patch: count((row) => row.model_outcome === "success" && !row.generated && !row.no_task),
    qa_passed: count((row) => row.qa_passed),
    pr_created: count((row) => row.pr_created),
    estimated_runner_minutes: rows.reduce((sum, row) => sum + row.estimated_runner_minutes, 0),
    p95_duration_minutes: sorted.length ? Math.ceil(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] / 60_000) : 0,
  });
}

export function summarizeAgentQueue(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.agent_key !== "string" ||
        !["completed", "failed", "queued", "claimed", "in_progress", "blocked", "cancelled"].includes(row.status)) continue;
    const item = map.get(row.agent_key) || { agent: row.agent_key, total: 0, completed: 0, failed: 0, active: 0 };
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000_000) continue;
    item.total += count;
    if (row.status === "completed") item.completed += count;
    if (row.status === "failed") item.failed += count;
    if (["queued", "claimed", "in_progress"].includes(row.status)) item.active += count;
    map.set(row.agent_key, item);
  }
  return Object.freeze([...map.values()].map((item) => Object.freeze(item)));
}

export function inspectPostMerge({ runs = [], deployments = [], now = Date.now() } = {}) {
  const warnings = [];
  const failed = runs.filter((run) => run.conclusion === "failure" && run.event === "push" && now - dateMs(run.created_at) <= 7 * DAY);
  if (failed.length) warnings.push({ code: "postmerge_workflow_failure", severity: "high", count: failed.length, message: "Проверки после объединения PR завершились ошибкой" });
  const badDeployments = deployments.filter((item) => ["error", "failure", "inactive", "in_progress"].includes(item.state));
  if (badDeployments.length) warnings.push({ code: "postmerge_deployment", severity: "high", count: badDeployments.length, message: "Развёртывание после объединения PR требует внимания" });
  return warnings;
}

function dateMs(value) {
  const result = Date.parse(value || "");
  return Number.isFinite(result) ? result : 0;
}

export function formatMoscowTimestamp(value = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return parts.day + "." + parts.month + "." + parts.year + " " + parts.hour + ":" + parts.minute + " МСК";
}

export function shouldPublishGovernanceReport({ eventName = "", disputes = [], warnings = [], proposals = [] } = {}) {
  return eventName === "schedule" || disputes.length > 0 || warnings.length > 0 || proposals.length > 0;
}

export function classifyPullEvidence({ complete = false, disputes = [], pulls = [] } = {}) {
  if (!complete) {
    return {
      arbiter: { state: "no_data", evidence_count: 0, detail: "список PR или перечень их файлов загружен не полностью" },
      integrator: { state: "no_data", evidence_count: 0, detail: "список PR или перечень их файлов загружен не полностью" },
    };
  }
  return {
    arbiter: disputes.length
      ? { state: "confirmed", evidence_count: disputes.length, detail: "обнаружены пересечения файлов между PR" }
      : { state: "checked_no_signal", evidence_count: 0, detail: "в полной выборке PR пересечений файлов не обнаружено" },
    integrator: pulls.length
      ? { state: "confirmed", evidence_count: pulls.length, detail: "план проверки построен по " + pulls.length + " PR; сам по себе он не подтверждает merge" }
      : { state: "checked_no_signal", evidence_count: 0, detail: "полная выборка не содержит открытых PR для плана внедрения" },
  };
}

function clean(value, maxLength = 150) {
  return String(value ?? "")
    .replace(/[\r\n\t\u0000-\u001f]/g, " ")
    .replace(/[&<>"'|*_~#\[\]()]/g, (ch) => "&#" + ch.charCodeAt(0) + ";")
    .trim()
    .slice(0, maxLength);
}

export function renderBossBrief({ disputes = [], warnings = [], proposals = [], queueHealth = null,
  queueLink = "not_configured", legalEvidenceSummary = null, legalEvidenceLink = "not_configured",
  moderationSummary = null, moderationLink = "not_configured", qwenMetrics = null,
  count = 0, limited = false } = {}) {
  const highWarnings = warnings.filter((item) => item?.severity === "high").length;
  const mediumWarnings = warnings.filter((item) => item?.severity === "medium").length;
  const highRiskDisputes = disputes.filter((item) => item?.highRisk === true).length;
  const queueAvailable = queueLink === "connected" && queueHealth !== null;
  const legalRowsValid = Array.isArray(legalEvidenceSummary) && legalEvidenceSummary.length === 2;
  const legalAvailable = legalEvidenceLink === "connected" && legalRowsValid && legalEvidenceSummary.every((row) =>
    row && ["source_checked", "change_detected"].includes(row.latest_status)
  );
  const legalChangeDetected = legalAvailable && legalEvidenceSummary.some((row) => row.latest_status === "change_detected");
  const moderationAvailable = moderationLink === "connected" && moderationSummary !== null;
  const moderationSuppressed = moderationAvailable && moderationSummary.total_bucket === "suppressed";
  const qwenUnconfirmed = Number.isSafeInteger(qwenMetrics?.model_result_unconfirmed) &&
    qwenMetrics.model_result_unconfirmed >= 0 ? qwenMetrics.model_result_unconfirmed : null;
  const sourcesUnknown = !queueAvailable || !legalAvailable || !moderationAvailable || !qwenMetrics ||
    qwenUnconfirmed === null || moderationSuppressed;
  const queueIssues = queueAvailable && (queueHealth.failed_last_24h > 0 || queueHealth.expired_leases > 0);
  const status = highWarnings || highRiskDisputes || queueIssues || legalChangeDetected || qwenUnconfirmed > 0
    ? "требует внимания"
    : limited || sourcesUnknown
      ? "данные неполные; готовность не подтверждена"
      : "проверенные источники без критического сигнала";
  const queue = queueAvailable
    ? "ожидают " + queueHealth.queued + ", выполняются " + queueHealth.in_progress +
      ", ошибки за сутки " + queueHealth.failed_last_24h + ", просроченные аренды " + queueHealth.expired_leases
    : "не подтверждена";
  let nextStep = "Продолжить наблюдение; отсутствие новых сигналов не означает, что исправления внедрены.";
  if (highWarnings) nextStep = "Разобрать подтверждённые предупреждения высокой важности.";
  else if (highRiskDisputes) nextStep = "Сверить PR, затрагивающие защищённые файлы.";
  else if (queueIssues) nextStep = "Разобрать сбои и просроченные аренды очереди.";
  else if (qwenUnconfirmed > 0) nextStep = "Разобрать запуски Qwen, для которых этапы результата не подтверждены.";
  else if (limited) nextStep = "Повторить обзор после восстановления полной выборки.";
  else if (sourcesUnknown) nextStep = "Восстановить недоступные источники; их отсутствие не считать нулевой статистикой.";
  else if (proposals.length) nextStep = "Рассмотреть предложения штаба; они не применяются автоматически.";
  return [
    "## Кратко для Босса",
    "- Состояние: " + status + (count ? "; проверено PR: " + count : "" ) + ".",
    "- Сигналы: высокая важность — " + highWarnings + ", средняя — " + mediumWarnings + "; пересечения PR — " + disputes.length + " (защищённых — " + highRiskDisputes + ").",
    "- Очередь Supabase: " + queue + ".",
    "- Qwen: " + (qwenMetrics
      ? "запусков " + qwenMetrics.runs + ", анализ без patch " + qwenMetrics.model_no_patch +
        ", patch " + qwenMetrics.model_generated + ", результат не подтверждён " +
        (qwenUnconfirmed === null ? "метрика отсутствует" : qwenUnconfirmed) +
        ", QA пройдена " + qwenMetrics.qa_passed + ", PR " + qwenMetrics.pr_created
      : "метрики не подтверждены") + ".",
    "- LEGAL: " + (legalChangeDetected ? "обнаружено изменение; требуется проверка человека" : legalAvailable ? "техническая сводка доступна; решения остаются на проверке человека" : "данные не подтверждены") +
      "; MODERATOR: " + (moderationSuppressed ? "агрегат подавлен порогом приватности" : moderationAvailable ? "агрегат доступен" : "данные не подтверждены") + ".",
    "- Предложения к рассмотрению: " + proposals.length + "; автоматически не утверждаются.",
    "- Следующий шаг: " + nextStep,
  ].join("\n");
}

function sortedNumbers(numbers) {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export function findDisputes(pulls = []) {
  const result = [];
  for (let i = 0; i < pulls.length; i++) {
    for (let j = i + 1; j < pulls.length; j++) {
      const a = pulls[i], b = pulls[j];
      if (!Array.isArray(a.files) || !Array.isArray(b.files)) continue;
      const bFiles = new Set(b.files);
      const overlap = a.files.filter((path) =>
        bFiles.has(path) && !path.startsWith("docs/") && path !== "CHANGELOG.md"
      );
      if (!overlap.length) continue;
      result.push({
        prs: sortedNumbers([a.number, b.number]),
        files: overlap.slice(0, 8),
        highRisk: overlap.some((p) =>
          p.startsWith("supabase/") || p.startsWith(".github/") || p.startsWith("scripts/")
        ),
      });
    }
  }
  return result;
}

export function inspectAgents({ pulls = [], coderRuns = [], now = Date.now() } = {}) {
  const warnings = [];
  const active = [...coderRuns].sort((a, b) => dateMs(b.created_at) - dateMs(a.created_at));
  const recent = active.filter((run) => now - dateMs(run.created_at) <= 7 * DAY);
  const failures = recent.filter((run) => run.conclusion === "failure");
  const overdue = active.filter((run) =>
    (run.status === "in_progress" || run.status === "queued") &&
    now - dateMs(run.created_at) > 2 * 60 * 60 * 1000
  );
  if (failures.length >= 3) {
    warnings.push({
      code: "repeated_failures",
      severity: "high",
      count: failures.length,
      message: "Локальный Qwen-разработчик: минимум три неуспешных запуска за 7 дней",
    });
  }
  if (overdue.length) {
    warnings.push({
      code: "stuck_runs",
      severity: "high",
      count: overdue.length,
      message: "Локальный Qwen-разработчик: запуск выполняется или ожидает более 2 часов",
    });
  }
  const latest = active[0];
  if (latest && now - dateMs(latest.created_at) > 48 * 60 * 60 * 1000) {
    warnings.push({
      code: "no_recent_run",
      severity: "medium",
      count: 1,
      message: "Нет новых запусков Qwen-разработчика более 48 часов; проверить расписание",
    });
  }
  const stale = pulls.filter((pr) =>
    !pr.draft && now - dateMs(pr.updated_at) > 4 * DAY
  );
  if (stale.length) {
    warnings.push({
      code: "stale_prs",
      severity: "medium",
      count: stale.length,
      prs: stale.slice(0, 10).map((pr) => pr.number),
      message: "Открытые нечерновые PR без обновлений более 4 дней",
    });
  }
  return warnings;
}

export function proposeRecruitment({ disputes = [], warnings = [], activeRoles = [] } = {}) {
  const proposals = [];
  if (disputes.length >= 3 && !activeRoles.includes("integration_specialist")) {
    proposals.push({
      key: "integration_specialist",
      role: "Координатор интеграции изменений",
      reason: "Одновременно обнаружено не менее трёх пересечений файлов между открытыми PR",
      permissions: "Только чтение diff и предложения порядка объединения; без merge",
    });
  }
  const failed = warnings.find((w) => w.code === "repeated_failures");
  if (failed) {
    proposals.push({
      key: "coder_diagnostician",
      role: "Диагност локального кодирующего агента",
      reason: "Повторяются сбои Qwen-кодера; нужна проверка причин по техническим кодам ошибок",
      permissions: "Анализ статусов CI и предложений исправлений; без доступа к секретам",
    });
  }
  const stale = warnings.find((w) => w.code === "stale_prs");
  if (stale && stale.count >= 4) {
    proposals.push({
      key: "pr_triage",
      role: "Куратор очереди Pull Request",
      reason: "Не менее четырёх PR долго ожидают движения",
      permissions: "Классификация очереди и рекомендации; без закрытия, merge и удаления",
    });
  }
  return proposals;
}

const MODERATOR_QA_GUIDANCE = Object.freeze({
  targeted_harassment: "Проверить синтетические примеры адресной травли и отличать их от несогласия без личных нападок.",
  hate_or_discrimination: "Проверить синтетические примеры дискриминационного нападения и нейтрального обсуждения темы.",
  threat_or_intimidation: "Проверить синтетические примеры прямых угроз и отличать их от безобидного образного выражения.",
  negative_personal_call: "Проверить границу между критикой действий и оскорблением человека на синтетических примерах.",
  spam_or_repeated_abuse: "Проверить синтетические повторы и убедиться, что обычное повторное сообщение не трактуется как травля.",
  unsafe_image: "Проверить синтетические изображения и безопасные тестовые заглушки для запрещённых визуальных материалов.",
  personal_data_in_image: "Проверить синтетические изображения с тестовыми контактными данными и отсутствие их вывода в отчёт.",
  unclear_safety_signal: "Проверить неоднозначные синтетические примеры и понятную передачу сложных случаев человеку.",
});

export function buildModeratorRecommendations(summary = null) {
  if (!summary || !Array.isArray(summary.categories) ||
      summary.total_bucket === "none" || summary.total_bucket === "suppressed") return [];
  const seen = new Set();
  const recommendations = [];
  for (const item of summary.categories.slice(0, 16)) {
    if (!item || !Object.hasOwn(MODERATOR_QA_GUIDANCE, item.category) ||
        !["medium", "high"].includes(item.severity) ||
        !["5_9", "10_24", "25_plus"].includes(item.count_bucket)) continue;
    const key = item.category + ":" + item.severity;
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push(MODERATOR_QA_GUIDANCE[item.category]);
  }
  return recommendations;
}

export function renderModerationStatus(summary = null, link = "not_configured") {
  const heading = "## MODERATOR — обезличенные сигналы безопасности";
  if (link !== "connected" || !summary) {
    return [heading, link === "not_configured"
      ? "Источник защищённых агрегатов не настроен; работа Надзирателя не подтверждена."
      : "Источник защищённых агрегатов недоступен или ответ отклонён; результат неизвестен."].join("\n");
  }
  const bucketLabel = {
    none: "школ с сигналами за последние 7 дней не обнаружено",
    suppressed: "школ с сигналами меньше пяти; данные скрыты и детализация не оценивается",
    "5_9": "школ с сигналами: 5–9",
    "10_24": "школ с сигналами: 10–24",
    "25_plus": "школ с сигналами: 25 и более",
  }[summary.total_bucket];
  const categories = summary.categories.map((item) =>
    item.category + "/" + item.severity + ": " + item.count_bucket.replace("_", "–")
  );
  const recommendations = buildModeratorRecommendations(summary);
  return [
    heading,
    "Период: 7 дней; только FAM_CURRENT; " + bucketLabel + ".",
    categories.length ? "Категории, отмеченные не менее чем в пяти школах: " + categories.join(", ") + "." :
      "Категории, встречающиеся менее чем в пяти школах, скрыты; выводы по ним не делаются.",
    "Это автоматические сигналы для проверки, не подтверждённые нарушения. FAM_RU не оценён.",
    recommendations.length
      ? "Рекомендации для Испытателя (QA): " + recommendations.join(" ") + " Только синтетические проверки; без санкций, автоматических задач и изменений production."
      : "Рекомендаций по агрегату нет; скрытые малые группы не интерпретируются.",
  ].join("\n");
}

export function makeReport({ disputes = [], warnings = [], proposals = [], integrationPlan = null, queueHealth = null, queueLink = "not_configured", agentMetrics = [], qwenMetrics = null, developmentAdvisor = null, developmentScopes = {}, legalScopes = {}, legalEvidenceSummary = null, legalEvidenceLink = "not_configured", moderationSummary = null, moderationLink = "not_configured", staffSignals = {}, count = 0, limited = false, now = Date.now() } = {}) {
  const lines = [
    REPORT_MARKER,
    "# FAM — штаб контроля агентов",
    "",
    "Ежедневный доклад на " + formatMoscowTimestamp(now) + ".",
    "Проверено открытых PR: " + count + (limited ? " (достигнут лимит выборки; отчёт неполный)" : "") + ".",
    "",
    renderBossBrief({ disputes, warnings, proposals, queueHealth, queueLink,
      legalEvidenceSummary, legalEvidenceLink, moderationSummary, moderationLink, qwenMetrics, count, limited }),
    "",
    "## ARBITER — конфликты изменений",
  ];
  if (!disputes.length) lines.push("Пересечений изменяемых кодовых файлов не обнаружено в проверенной выборке.");
  for (const d of disputes.slice(0, 15)) {
    lines.push("- PR " + d.prs.map((n) => "#" + n).join(" ↔ ") + ": " +
      d.files.map((f) => clean(f, 140)).join(", ") +
      (d.highRisk ? " (защищённая область; высокий риск)" : " (требуется сверка diff)"));
  }
  if (disputes.length > 15) lines.push("- Остальные конфликты: " + (disputes.length - 15) + " (нужна ручная проверка).");
  lines.push("", "## INTEGRATOR — координация пересекающихся PR");
  lines.push(integrationPlan ? formatIntegrationPlan(integrationPlan) :
    "Не запускался: план интеграции отсутствует.");
  lines.push("", "## INSPECTOR — эффективность и простой");
  if (!warnings.length) lines.push("Подтверждённых технических сигналов в проверенной выборке нет.");
  for (const w of warnings) {
    lines.push("- [" + clean(w.severity) + "] " + clean(w.message) +
      "; случаев: " + w.count +
      (w.prs?.length ? "; PR: " + w.prs.map((n) => "#" + n).join(", ") : ""));
  }
  lines.push("", "## SUPABASE — единая техническая очередь");
  if (queueHealth && queueLink === "connected") {
    lines.push(
      "Связь подтверждена: ожидают " + queueHealth.queued +
      "; захвачены " + queueHealth.claimed +
      "; выполняются " + queueHealth.in_progress +
      "; с ошибками за сутки " + queueHealth.failed_last_24h +
      "; просроченные аренды " + queueHealth.expired_leases +
      "; возраст старейшей ожидающей, минут " + queueHealth.oldest_queued_minutes + "."
    );
  } else if (queueLink === "not_configured") {
    lines.push("Связь Supabase → GitHub не настроена: проверка очереди не выполнялась.");
  } else {
    lines.push("Связь Supabase → GitHub недоступна или ответ отклонён; здоровье очереди не подтверждено.");
  }
  lines.push("В штаб поступают только счётчики задач; тексты, ID и данные учеников не передаются.");
  lines.push("", "## Метрики работы агентов");
  if (!agentMetrics.length) lines.push("Агрегаты заданий недоступны; статистика не считается нулевой.");
  for (const item of agentMetrics) lines.push("- " + clean(item.agent, 50) + ": всего " + item.total + ", успешно " + item.completed + ", ошибка " + item.failed + ", активны " + item.active + ".");
  if (qwenMetrics) {
    lines.push("Qwen за последние запуски: всего " + qwenMetrics.runs + ", успешны " + qwenMetrics.successful + ", с ошибкой " + qwenMetrics.failed + ", без задачи " + qwenMetrics.no_task + ", анализ без patch " + qwenMetrics.model_no_patch + ", patch сгенерирован " + qwenMetrics.model_generated + ", QA прошла " + qwenMetrics.qa_passed + ", PR открыт " + qwenMetrics.pr_created + ", примерные runner-минуты " + qwenMetrics.estimated_runner_minutes + ", p95 длительности " + qwenMetrics.p95_duration_minutes + " мин.");
    lines.push("Runner-минуты оценены по длительности шагов последних 20 запусков; это не счёт и не стоимость. Анализ без patch не считается исправлением сайта.");
  } else lines.push("Метрики Actions пока недоступны.");
  lines.push("", "## RECRUITER — предложения по найму");
  if (!proposals.length) lines.push("Нет достаточных оснований создавать новые роли.");
  for (const p of proposals) {
    lines.push("- **" + clean(p.role) + "**: " + clean(p.reason, 300) +
      ". Права: " + clean(p.permissions, 250) + ".");
  }
  lines.push("", renderDevelopmentAdvisor(developmentAdvisor || buildDevelopmentAdvisor([])));
  lines.push("", renderDevelopmentScopeStatus(developmentScopes));
  lines.push("", renderLegalScopeStatus(legalScopes));
  lines.push("", renderLegalObservationStatus(legalEvidenceSummary, legalEvidenceLink));
  lines.push("", renderModerationStatus(moderationSummary, moderationLink));
  lines.push("", renderStaffSnapshot(staffSignals));
  lines.push("", "## Полномочия и ограничения",
    "- Сигналы основаны на метаданных GitHub, не на частных сообщениях пользователей.",
    "- Пересечение файлов — возможный конфликт, а не доказательство ошибки разработчика.",
    "- Отсутствие задач или ручное ожидание PR не равно бездействию агента.",
    "- RECRUITER только рекомендует новый профиль агента: создавать, включать, отключать и оплачивать агентов без одобрения владельца запрещено.",
    "- Этот процесс не имеет прав менять код, закрывать PR, выполнять merge или публиковать сайт.",
    "");
  return lines.join("\n");
}

export function renderDevelopmentScopeStatus(statuses = {}) {
  const labels = {
    confirmed: "агрегаты проверены, подготовлено только предложение",
    checked_no_signal: "агрегаты проверены, порог для гипотезы не достигнут",
    no_data: "не оценено: источник агрегатов этого контура не подключён",
  };
  const current = labels[statuses?.FAM_CURRENT] || labels.no_data;
  const ru = labels[statuses?.FAM_RU] || labels.no_data;
  return [
    "## Советник по развитию — охват версий",
    "- **FAM_CURRENT:** " + current + ".",
    "- **FAM_RU:** " + ru + ".",
    "Предложения относятся только к указанному контуру и не являются изменениями продукта.",
  ].join("\n");
}

export function renderLegalScopeStatus(statuses = {}) {
  const labels = {
    not_assessed: "не оценено: подтверждённый источник статуса не подключён",
    source_unavailable: "источник недоступен; готовность не подтверждена",
    evidence_pending_human_review: "свидетельства ожидают независимой проверки человека",
    criteria_evidenced_pending_release_decision: "критерии подтверждены; решение о выпуске не принято",
  };
  const current = labels[statuses?.FAM_CURRENT] || labels.not_assessed;
  const ru = labels[statuses?.FAM_RU] || labels.not_assessed;
  return [
    "## LEGAL — раздельные статусы FAM",
    "- **FAM_CURRENT:** " + current + ".",
    "- **FAM_RU:** " + ru + ".",
    "Статус одного контура не переносится на другой. Эти отметки не являются юридическим заключением или разрешением на выпуск.",
  ].join("\n");
}

export function renderLegalObservationStatus(rows = null, link = "not_configured") {
  const labels = {
    not_assessed: "наблюдений в архиве нет",
    source_checked: "официальный источник проверен, новых изменений не отмечено",
    change_detected: "зафиксировано изменение источника, требуется проверка человеком",
    source_unavailable: "источник был недоступен при последней проверке",
  };
  const heading = "## LEGAL — наблюдения официальных источников";
  if (link !== "connected" || !Array.isArray(rows)) {
    return [heading, link === "not_configured"
      ? "Защищённый источник архива не подключён; мониторинг не подтверждён."
      : "Архив недоступен или его ответ отклонён; статус неизвестен."].join("\n");
  }
  let validatedRows;
  try { validatedRows = validateLegalEvidenceSummaryResponse({ ok: true, scopes: rows }); }
  catch { return [heading, "Архив вернул неожиданные поля или статусы; результат неизвестен."].join("\n"); }
  const indexed = new Map(validatedRows.map((row) => [row.scope, row]));
  return [
    heading,
    ...["FAM_CURRENT", "FAM_RU"].map((scope) => {
      const row = indexed.get(scope);
      if (!row) return "- **" + scope + ":** запись отсутствует; результат неизвестен.";
      const checked = row.latest_checked_at ? "; последняя запись " + formatMoscowTimestamp(row.latest_checked_at) : "";
      return "- **" + scope + ":** " + (labels[row.latest_status] || labels.not_assessed) +
        "; наблюдений за 30 дней: " + row.observations_30d + checked + ".";
    }),
    "Это только техническая фиксация состояния публичного источника. Она не устанавливает применимость закона, юридическую готовность или разрешение на выпуск; решения ожидают человека.",
  ].join("\n");
}

export function inspectLegalEvidenceWarnings(rows = null) {
  if (!Array.isArray(rows)) return [];
  let validatedRows;
  try { validatedRows = validateLegalEvidenceSummaryResponse({ ok: true, scopes: rows }); }
  catch { return []; }
  return validatedRows.flatMap((row) => row.latest_status === "source_unavailable" ? [{
    code: "legal_source_unavailable",
    severity: "medium",
    count: 1,
    message: "LEGAL: официальный источник недоступен для " + row.scope + "; правовая готовность не подтверждена",
  }] : []);
}

export function summarizeLegalStaffSignal(rows = null, link = "not_configured") {
  if (link !== "connected" || !Array.isArray(rows) || rows.length !== 2) {
    return Object.freeze({
      state: "no_data",
      evidence_count: 0,
      detail: "защищённая сводка юридических наблюдений не подключена или недоступна; правовые выводы не подтверждены",
    });
  }
  let validatedRows;
  try { validatedRows = validateLegalEvidenceSummaryResponse({ ok: true, scopes: rows }); }
  catch {
    return Object.freeze({
      state: "no_data",
      evidence_count: 0,
      detail: "сводка LEGAL содержит неподтверждённые поля; статус неизвестен",
    });
  }
  const evidenceCount = validatedRows.reduce((sum, row) => sum + row.observations_30d, 0);
  return Object.freeze({
    state: evidenceCount > 0 ? "confirmed" : "no_data",
    evidence_count: evidenceCount,
    detail: evidenceCount > 0
      ? "получена только агрегированная история технических проверок публичных источников; юридическая применимость и решения остаются на проверке человека"
      : "за последние 30 дней в защищённой сводке нет наблюдений; мониторинг и правовая готовность не подтверждены",
  });
}

async function api(path, token, options = {}) {
  const response = await fetch("https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY + path, {
    ...options,
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error("GitHub API: HTTP " + response.status + " при " + path.split("?")[0]);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function publishIssue(report, token) {
  const existing = await api("/issues?state=open&per_page=100", token);
  if (!Array.isArray(existing) || existing.length === 100) {
    throw new Error("Недостаточно данных для безопасного поиска уже созданного отчёта.");
  }
  const found = existing.find((issue) =>
    !issue.pull_request && typeof issue.body === "string" &&
    issue.body.includes(REPORT_MARKER)
  );
  const title = "FAM: ежедневный доклад штаба агентов";
  if (found) {
    await api("/issues/" + found.number, token, {
      method: "PATCH",
      body: JSON.stringify({ title, body: report }),
    });
    return "Обновлена задача #" + found.number;
  }
  const created = await api("/issues", token, {
    method: "POST",
    body: JSON.stringify({ title, body: report }),
  });
  return "Создана задача #" + created.number;
}

export async function main() {
  const token = process.env.GH_TOKEN;
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPOSITORY || "")) {
    throw new Error("Отсутствует токен GitHub Actions или корректное имя репозитория.");
  }
  const prs = await api("/pulls?state=open&per_page=100", token);
  if (!Array.isArray(prs)) throw new Error("Некорректный список PR.");
  const selected = prs.slice(0, MAX_PRS);
  const pulls = await Promise.all(selected.map(async (pr) => {
    const files = await api("/pulls/" + pr.number + "/files?per_page=100", token);
    if (!Array.isArray(files) || files.length === 100) {
      return { ...pr, files: null };
    }
    return { ...pr, files: files.map((f) => f.filename).filter((f) => typeof f === "string") };
  }));
  const workflows = await api("/actions/workflows/" + CORE_WORKFLOW + "/runs?branch=main&per_page=100", token);
  if (!Array.isArray(workflows.workflow_runs)) throw new Error("Не удалось получить запуски кодера.");
  const runDetails = await Promise.all(workflows.workflow_runs.slice(0, 20).map(async (run) => {
    try {
      const jobs = await api("/actions/runs/" + run.id + "/jobs?per_page=100", token);
      return { ...run, jobs: jobs.jobs || [] };
    } catch {
      return { ...run, jobs: [] };
    }
  }));
  const disputes = findDisputes(pulls);
  const pullEvidenceComplete = prs.length <= selected.length && pulls.every((pr) => Array.isArray(pr.files));
  const pullStaffSignals = classifyPullEvidence({ complete: pullEvidenceComplete, disputes, pulls });
  const warnings = inspectAgents({ pulls, coderRuns: workflows.workflow_runs });
  const deploymentAuditResults = await Promise.allSettled([
    api("/actions/workflows/fam-domain-sync.yml/runs?branch=main&per_page=20", token),
    api("/actions/workflows/fam-netlify-production.yml/runs?branch=main&per_page=20", token),
  ]);
  const deploymentAuditAvailable = deploymentAuditResults.every((item) => item.status === "fulfilled" && Array.isArray(item.value.workflow_runs));
  const deploymentRuns = deploymentAuditResults.flatMap((item) =>
    item.status === "fulfilled" && Array.isArray(item.value.workflow_runs) ? item.value.workflow_runs : []
  );
  warnings.push(...inspectPostMerge({ runs: deploymentRuns }));
  if (!deploymentAuditAvailable) warnings.push({
    code: "postmerge_audit_unavailable", severity: "medium", count: 1,
    message: "Не удалось проверить состояние CI и развёртывания после объединения PR",
  });
  // The same protected server bridge supplies only predefined aggregate counts.
  // Raw Supabase task payloads and student content never enter GitHub.
  const bridgeUrl = process.env.FAM_AGENT_BRIDGE_URL || "";
  const bridgeToken = process.env.FAM_AGENT_WORKER_TOKEN || "";
  let queueHealth = null;
  let queueLink = "not_configured";
  let agentMetrics = [];
  let developmentAdvisor = buildDevelopmentAdvisor([]);
  let developmentAdvisorLink = "not_configured";
  let moderationSummary = null;
  let moderationLink = "not_configured";
  let legalEvidenceSummary = null;
  let legalEvidenceLink = "not_configured";
  if (bridgeUrl && bridgeToken) {
    try {
      queueHealth = await fetchQueueHealth({ url: bridgeUrl, token: bridgeToken });
      const metrics = await fetchAgentMetrics({ url: bridgeUrl, token: bridgeToken });
      agentMetrics = summarizeAgentQueue(metrics);
      warnings.push(...inspectQueueHealth(queueHealth));
      queueLink = "connected";
    } catch {
      queueLink = "unavailable";
      warnings.push({
        code: "supabase_bridge_unavailable",
        severity: "medium",
        count: 1,
        message: "Не удалось получить защищённые агрегаты очереди Supabase",
      });
    }
    try {
      const snapshots = await fetchDevelopmentAdvisorSnapshots({ url: bridgeUrl, token: bridgeToken });
      developmentAdvisor = buildDevelopmentAdvisor(snapshots);
      developmentAdvisorLink = "connected";
    } catch {
      developmentAdvisorLink = "unavailable";
      warnings.push({
        code: "development_advisor_metrics_unavailable",
        severity: "medium",
        count: 1,
        message: "Не удалось получить ограниченные дневные агрегаты Советника по развитию",
      });
    }
    try {
      moderationSummary = await fetchModerationSummary({ url: bridgeUrl, token: bridgeToken });
      moderationLink = "connected";
    } catch {
      moderationLink = "unavailable";
      warnings.push({
        code: "moderation_metrics_unavailable",
        severity: "medium",
        count: 1,
        message: "Не удалось получить безопасные агрегаты сигналов модерации",
      });
    }
    try {
      legalEvidenceSummary = await fetchLegalEvidenceSummary({ url: bridgeUrl, token: bridgeToken });
      warnings.push(...inspectLegalEvidenceWarnings(legalEvidenceSummary));
      legalEvidenceLink = "connected";
    } catch {
      legalEvidenceLink = "unavailable";
      warnings.push({
        code: "legal_evidence_summary_unavailable",
        severity: "medium",
        count: 1,
        message: "Не удалось получить безопасную сводку наблюдений LEGAL; правовой статус неизвестен",
      });
    }
  } else if (bridgeUrl || bridgeToken) {
    queueLink = "incomplete_configuration";
    warnings.push({
      code: "supabase_bridge_incomplete",
      severity: "medium",
      count: 1,
      message: "Не полностью настроено подключение штаба к защищённой очереди Supabase",
    });
  }
  let inspectorOutcome = "Автоматическая постановка не запускалась: нет подтверждённого сигнала или защищённого моста.";
  const syntheticSignal = process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
    ? (process.env.FAM_INSPECTOR_SYNTHETIC_SIGNAL || "none") : "none";
  if (!new Set(["none", "synthetic_ci_workflow_failure", "synthetic_qwen_runtime_smoke"]).has(syntheticSignal)) {
    throw new Error("Недопустимый код синтетического сигнала INSPECTOR.");
  }
  let selectedSignal = null;
  if (syntheticSignal === "synthetic_ci_workflow_failure" || syntheticSignal === "synthetic_qwen_runtime_smoke") {
    selectedSignal = {
      signal_code: "synthetic_ci_workflow_failure",
      occurrences: 1,
      event_id: (syntheticSignal === "synthetic_qwen_runtime_smoke" ? "runtime_smoke:" : "synthetic:") + (process.env.GITHUB_RUN_ID || "missing"),
    };
    inspectorOutcome = "Синтетическое испытание INSPECTOR: CI-сигнал тестовый, ошибка сайта не создавалась.";
  } else if (bridgeUrl && bridgeToken) {
    const candidate = warnings.map(mapInspectorWarning).find(Boolean);
    if (candidate) {
      selectedSignal = {
        ...candidate,
        event_id: "github:" + (process.env.GITHUB_RUN_ID || "missing") + ":" + candidate.signal_code,
      };
    }
  }
  if (selectedSignal && bridgeUrl && bridgeToken) {
    const result = await enqueueInspectorTask({
      url: bridgeUrl, token: bridgeToken,
      signalCode: selectedSignal.signal_code,
      eventId: selectedSignal.event_id,
      occurrences: selectedSignal.occurrences,
    });
    inspectorOutcome += "; результат очереди: " + result.reason +
      (result.task_created ? "; задание создано" : "; новое задание не создано");
    if (result.task_created) {
      await api("/actions/workflows/fam-codex-developer.yml/dispatches", token, {
        method: "POST",
        body: JSON.stringify({ ref: "main" }),
      });
      inspectorOutcome += "; Qwen workflow запущен";
    }
  }
  const proposals = proposeRecruitment({ disputes, warnings, activeRoles: ["integration_specialist"] });
  const qwenMetrics = summarizeQwenRuns(runDetails);
  const integrationPlan = buildIntegrationPlan({
    pulls, disputes,
    limited: prs.length > selected.length || pulls.some((p) => p.files === null),
  });
  const staffSignals = {
    arbiter: pullStaffSignals.arbiter,
    inspector: {
      state: warnings.length ? "confirmed" : "checked_no_signal",
      evidence_count: warnings.length,
      detail: warnings.length ? "собраны предупреждения из проверенных источников" : "проверенные источники не дали предупреждений",
    },
    qwen: {
      state: qwenMetrics.runs ? "confirmed" : "checked_no_signal",
      evidence_count: qwenMetrics.runs,
      detail: qwenMetrics.runs
        ? "запуски: " + qwenMetrics.runs + ", patch сгенерирован: " + qwenMetrics.model_generated + ", без patch: " + qwenMetrics.model_no_patch
        : "в выборке запусков нет",
    },
    qa: {
      state: qwenMetrics.qa_passed ? "confirmed" : qwenMetrics.runs ? "checked_no_signal" : "no_data",
      evidence_count: qwenMetrics.qa_passed,
      detail: qwenMetrics.qa_passed ? "независимые проверки patch завершились успешно" : "успешных независимых проверок patch в выборке нет",
    },
    integrator: pullStaffSignals.integrator,
    recruiter: {
      state: proposals.length ? "confirmed" : "checked_no_signal",
      evidence_count: proposals.length,
      detail: proposals.length ? "подготовлены обоснованные предложения" : "порог для новых ролей не достигнут",
    },
    legal: summarizeLegalStaffSignal(legalEvidenceSummary, legalEvidenceLink),
    development_advisor: {
      state: developmentAdvisorLink === "connected" ? developmentAdvisor.state : "no_data",
      evidence_count: developmentAdvisorLink === "connected" ? developmentAdvisor.proposals.length : 0,
      detail: developmentAdvisorLink === "connected"
        ? "проверены только дневные агрегаты объявлений FAM_CURRENT; гипотезы переданы Боссу без автоматической постановки задач"
        : "агрегированный источник Советника не подключён или недоступен; работа не подтверждена",
    },
    moderator: {
      state: moderationLink !== "connected" || moderationSummary?.total_bucket === "suppressed"
        ? "no_data"
        : moderationSummary?.total_bucket === "none" ? "checked_no_signal" : "confirmed",
      evidence_count: moderationLink === "connected" && moderationSummary?.total_bucket !== "suppressed" ? 1 : 0,
      detail: moderationLink !== "connected"
        ? "защищённые агрегаты модерации не подключены или недоступны"
        : moderationSummary.total_bucket === "suppressed"
          ? "сигналов меньше пяти; из-за порога приватности вывод невозможен"
          : moderationSummary.total_bucket === "none"
            ? "проверен 7-дневный агрегат FAM_CURRENT; сигналов нет"
            : "проверен 7-дневный агрегат FAM_CURRENT; сигналы не трактуются как подтверждённые нарушения",
    },
  };
  const report = makeReport({
    disputes, warnings, proposals, integrationPlan, queueHealth, queueLink, agentMetrics,
    qwenMetrics, developmentAdvisor, legalEvidenceSummary, legalEvidenceLink, moderationSummary, moderationLink,
    developmentScopes: {
      FAM_CURRENT: developmentAdvisorLink === "connected" ? developmentAdvisor.state : "no_data",
      FAM_RU: "no_data",
    },
    staffSignals, count: selected.length,
    limited: prs.length > selected.length || pulls.some((p) => p.files === null),
  }) + "\n## INSPECTOR → Qwen\n" + inspectorOutcome + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  }
  process.stdout.write("FAM governance: конфликтов " + disputes.length +
    ", предупреждений " + warnings.length + ", предложений " + proposals.length + "\n");
  if (shouldPublishGovernanceReport({
    eventName: process.env.GITHUB_EVENT_NAME,
    disputes, warnings, proposals,
  })) {
    process.stdout.write(await publishIssue(report, token) + "\n");
  } else {
    process.stdout.write("Новых сигналов нет, отдельный issue не создаётся.\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write("FAM governance: " + err.message + "\n");
    process.exitCode = 1;
  });
}
