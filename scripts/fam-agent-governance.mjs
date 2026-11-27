import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildIntegrationPlan, formatIntegrationPlan } from "./fam-integration-coordinator.mjs";
import { enqueueInspectorTask, fetchAgentMetrics, fetchDevelopmentAdvisorSnapshots, fetchQueueHealth, inspectQueueHealth, mapInspectorWarning } from "./fam-governance-bridge.mjs";
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

function clean(value, maxLength = 150) {
  return String(value ?? "")
    .replace(/[\r\n\t\u0000-\u001f]/g, " ")
    .replace(/[&<>"'|*_~#\[\]()]/g, (ch) => "&#" + ch.charCodeAt(0) + ";")
    .trim()
    .slice(0, maxLength);
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

export function makeReport({ disputes = [], warnings = [], proposals = [], integrationPlan = null, queueHealth = null, queueLink = "not_configured", agentMetrics = [], qwenMetrics = null, developmentAdvisor = null, legalScopes = {}, staffSignals = {}, count = 0, limited = false, now = Date.now() } = {}) {
  const lines = [
    REPORT_MARKER,
    "# FAM — штаб контроля агентов",
    "",
    "Ежедневный доклад на " + formatMoscowTimestamp(now) + ".",
    "Проверено открытых PR: " + count + (limited ? " (достигнут лимит выборки; отчёт неполный)" : "") + ".",
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
  lines.push("", renderLegalScopeStatus(legalScopes));
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
    arbiter: { state: "confirmed", evidence_count: disputes.length, detail: "сводка по конфликтам и открытым PR сформирована" },
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
    integrator: {
      state: "confirmed", evidence_count: pulls.length,
      detail: "план проверки построен по " + pulls.length + " PR; сам по себе он не подтверждает merge",
    },
    recruiter: {
      state: proposals.length ? "confirmed" : "checked_no_signal",
      evidence_count: proposals.length,
      detail: proposals.length ? "подготовлены обоснованные предложения" : "порог для новых ролей не достигнут",
    },
    legal: {
      state: "no_data",
      evidence_count: 0,
      detail: "аутентифицированные статусы юридической проверки по FAM_CURRENT и FAM_RU ещё не подключены",
    },
    development_advisor: {
      state: developmentAdvisorLink === "connected" ? developmentAdvisor.state : "no_data",
      evidence_count: developmentAdvisorLink === "connected" ? developmentAdvisor.proposals.length : 0,
      detail: developmentAdvisorLink === "connected"
        ? "проверены только дневные агрегаты объявлений; гипотезы переданы Боссу без автоматической постановки задач"
        : "агрегированный источник Советника не подключён или недоступен; работа не подтверждена",
    },
  };
  const report = makeReport({
    disputes, warnings, proposals, integrationPlan, queueHealth, queueLink, agentMetrics,
    qwenMetrics, developmentAdvisor, staffSignals, count: selected.length,
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
