
import { analyzeTechnicalSignals } from "./fam-agent-analyst.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const API_ROOT = "https://api.github.com";
const PUBLIC_SITE_URL = "https://spartakdubov059.github.io/fam-website/";
const SNAPSHOT_KEYS = ["generated_at", "report_date", "daily_report", "agent_statuses", "cron_jobs", "latest_system_health", "latest_coder_task", "latest_site_error_check", "worker_http_6h", "failed_tasks_24h", "site_error_events_24h"];

function safeLabel(value, maxLength = 100) {
  return String(value ?? "unknown")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[|\[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || "unknown";
}

function safeGithubUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "github.com" && url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function summarizeWorkflowRuns(runs, now = new Date()) {
  const cutoff = now.getTime() - DAY_MS;
  const grouped = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const createdAt = Date.parse(run?.created_at ?? "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff || createdAt > now.getTime()) continue;
    const name = safeLabel(run?.name);
    const item = grouped.get(name) ?? {
      name,
      total_24h: 0,
      success: 0,
      failure: 0,
      in_progress: 0,
      queued: 0,
      other: 0,
      latest: null,
    };
    item.total_24h += 1;
    if (run.status === "in_progress") item.in_progress += 1;
    else if (run.status === "queued" || run.status === "requested" || run.status === "waiting") item.queued += 1;
    else if (run.conclusion === "success") item.success += 1;
    else if (["failure", "timed_out", "action_required"].includes(run.conclusion)) item.failure += 1;
    else item.other += 1;
    if (!item.latest || createdAt > item.latest.created_ms) {
      item.latest = {
        status: safeLabel(run.status, 40),
        conclusion: safeLabel(run.conclusion ?? "pending", 40),
        created_at: new Date(createdAt).toISOString(),
        html_url: safeGithubUrl(run.html_url),
        run_number: Number.isSafeInteger(run.run_number) ? run.run_number : null,
        run_id: Number.isSafeInteger(run.id) ? run.id : null,
        created_ms: createdAt,
      };
    }
    grouped.set(name, item);
  }
  return [...grouped.values()]
    .map((item) => {
      if (item.latest) {
        const { created_ms, ...latest } = item.latest;
        item.latest = latest;
      }
      return item;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function actionStatus(item) {
  if (!item || typeof item !== "object") return "not_observed";
  if (item.status === "queued" || item.status === "in_progress") return item.status;
  if (item.status !== "completed") return "not_observed";
  if (item.conclusion === "success") return "success";
  if (item.conclusion === "skipped") return "skipped";
  if (item.conclusion === "cancelled") return "cancelled";
  if (["failure", "timed_out", "action_required", "startup_failure"].includes(item.conclusion)) return "failure";
  return "not_observed";
}

export function summarizeAgentJobStatuses(jobs) {
  if (!Array.isArray(jobs)) return null;
  const findJob = (name) => jobs.find((job) => job?.name === name) ?? null;
  const findStep = (job, name) => Array.isArray(job?.steps)
    ? job.steps.find((step) => step?.name === name) ?? null
    : null;
  const coder = findJob("Локальная модель готовит исправление");
  const qa = findJob("Независимая проверка без модели и секретов");
  const prManager = findJob("Подготовить PR и проверить исправление без публикации");
  return {
    coder: actionStatus(findStep(coder, "Запустить локальную модель и подготовить patch")),
    qa: actionStatus(qa),
    reviewer: actionStatus(findStep(qa, "Подготовить независимый статический Reviewer отчёт")),
    security: actionStatus(findStep(qa, "Запустить отдельный статический Security Agent")),
    performance: actionStatus(findStep(qa, "Запустить отдельный статический Performance Agent")),
    pr_manager: actionStatus(prManager),
  };
}

const PR_CHECK_ALLOWLIST = new Map([
  ["Russian content safety tests", "regression"],
  ["coder-qa-postgres", "coder_qa"],
  ["reporter-postgres", "reporter_qa"],
  ["postgres-safety", "database_safety"],
]);

export function summarizePullRequestChecks(checkRuns) {
  if (!Array.isArray(checkRuns)) return { status: "unavailable", checks: [] };
  const latest = new Map();
  for (const check of checkRuns) {
    const key = PR_CHECK_ALLOWLIST.get(check?.name);
    if (!key) continue;
    const timestamp = Date.parse(check?.started_at ?? check?.completed_at ?? "");
    const previous = latest.get(key);
    if (!previous || (Number.isFinite(timestamp) && timestamp > previous.timestamp)) {
      latest.set(key, { check, timestamp: Number.isFinite(timestamp) ? timestamp : 0 });
    }
  }
  const checks = [...latest.entries()].map(([key, { check }]) => {
    let status = "not_observed";
    if (check.status === "queued" || check.status === "requested" || check.status === "waiting") status = "queued";
    else if (check.status === "in_progress") status = "in_progress";
    else if (check.status === "completed") {
      if (check.conclusion === "success") status = "success";
      else if (check.conclusion === "neutral" || check.conclusion === "skipped") status = check.conclusion;
      else if (check.conclusion === "cancelled") status = "cancelled";
      else if (["failure", "timed_out", "action_required", "startup_failure"].includes(check.conclusion)) status = "failure";
      else status = "other";
    }
    return { key, status };
  }).sort((a, b) => a.key.localeCompare(b.key));
  return { status: checks.length ? "available" : "not_observed", checks };
}

export function sanitizePullRequests(pulls) {
  return (Array.isArray(pulls) ? pulls : [])
    .filter((pull) => pull?.state === "open" && Number.isSafeInteger(pull.number))
    .slice(0, 50)
    .map((pull) => ({
      number: pull.number,
      draft: pull.draft === true,
      html_url: safeGithubUrl(pull.html_url),
      created_at: typeof pull.created_at === "string" ? pull.created_at : null,
      checks: summarizePullRequestChecks(pull.check_runs),
    }));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function createDailyReport({
  snapshot = null,
  snapshotStatus = "unavailable",
  workflowRuns = [],
  workflowStatus = "unavailable",
  pullRequests = [],
  pullRequestStatus = "unavailable",
  agentJobStatus = "not_run_24h",
  agentJobStatuses = null,
  production = { status: "unknown" },
  siteProbe = { status: "unknown", http_status: null },
  now = new Date(),
} = {}) {
  const validSnapshot = snapshot && typeof snapshot === "object" &&
    SNAPSHOT_KEYS.every((key) => Object.hasOwn(snapshot, key));
  const workflows24h = summarizeWorkflowRuns(workflowRuns, now);
  const latestWorkflow = (pattern) => workflows24h
    .filter((workflow) => pattern.test(workflow.name))
    .sort((a, b) => (b.latest?.created_at ?? "").localeCompare(a.latest?.created_at ?? ""))[0]?.latest;
  const qaRun = latestWorkflow(/moderation regression/i);
  const coderRun = latestWorkflow(/local ai developer/i);
  const runOutcome = (run) => !run ? "not_run_24h" :
    run.conclusion === "pending" ? run.status : run.conclusion;
  const agentStatus = (key) => agentJobStatus === "available"
    ? (agentJobStatuses?.[key] ?? "not_observed")
    : agentJobStatus;
  const openPrs = sanitizePullRequests(pullRequests);
  const roles = [
    { role: "Orchestrator", status: validSnapshot && snapshot.daily_report ? "reported" : "not_reported" },
    { role: "Monitoring", status: (siteProbe.status === "reachable" ? "site_reachable" : safeLabel(siteProbe.status, 40)) +
      ";site_error_task:" + safeLabel(snapshot?.latest_site_error_check?.status ?? "unknown", 40) +
      ";worker_http:" + (validSnapshot
        ? count(snapshot.worker_http_6h?.success_count) + "/" + count(snapshot.worker_http_6h?.response_count) +
          "_success;http_errors:" + count(snapshot.worker_http_6h?.http_error_count)
        : "not_observed") },
    { role: "Analyst", status: analyzeTechnicalSignals(validSnapshot ? snapshot.site_error_events_24h : []).status },
    { role: "Coder", status: "queue:" + (validSnapshot ? safeLabel(snapshot.latest_coder_task?.status ?? "no_task", 40) : "unavailable") +
      ";run:" + agentStatus("coder") },
    { role: "QA", status: "patch:" + agentStatus("qa") + ";regression:" + runOutcome(qaRun) },
    { role: "Reviewer", status: agentStatus("reviewer") },
    { role: "Security Agent", status: agentStatus("security") },
    { role: "Performance Agent", status: agentStatus("performance") },
    { role: "PR Manager", status: agentStatus("pr_manager") + ";open_prs:" + openPrs.length },
    { role: "Deployment Monitor", status: safeLabel(production?.status ?? "unknown", 40) },
    { role: "Reporter", status: "ready_to_store" },
  ];
  return {
    report_date: now.toISOString().slice(0, 10),
    generated_at: now.toISOString(),
    sources: {
      supabase: validSnapshot ? "available" : (snapshotStatus === "available" ? "invalid_response" : snapshotStatus),
      github_actions: workflowStatus,
      pull_requests: pullRequestStatus,
      production_deployment: safeLabel(production?.status ?? "unknown", 40),
      public_site: safeLabel(siteProbe?.status ?? "unknown", 40),
    },
    supabase: validSnapshot ? {
      generated_at: snapshot.generated_at,
      report_date: snapshot.report_date,
      daily_report: snapshot.daily_report,
      agent_statuses: snapshot.agent_statuses,
      cron_jobs: snapshot.cron_jobs,
      latest_system_health: snapshot.latest_system_health,
      latest_coder_task: snapshot.latest_coder_task,
      latest_site_error_check: snapshot.latest_site_error_check,
      worker_http_6h: snapshot.worker_http_6h,
      failed_tasks_24h: snapshot.failed_tasks_24h,
      site_error_events_24h: snapshot.site_error_events_24h,
    } : null,
    technical_analysis: analyzeTechnicalSignals(validSnapshot ? snapshot.site_error_events_24h : []),
    workflows_24h: workflows24h,
    open_pull_requests: openPrs,
    role_statuses: roles,
    production_deployment: {
      status: safeLabel(production?.status ?? "unknown", 40),
      created_at: typeof production?.created_at === "string" ? production.created_at : null,
      html_url: safeGithubUrl(production?.html_url),
    },
    public_site: {
      status: safeLabel(siteProbe?.status ?? "unknown", 40),
      http_status: Number.isInteger(siteProbe?.http_status) ? siteProbe.http_status : null,
    },
    limitations: [
      "Проверка сайта выполняется один раз в сутки и не является непрерывным мониторингом.",
      "Окно pg_net ограничено шестью часами и показывает только распознанные JSON-ответы Worker; транспортные ошибки без ответа не привязываются к конкретной функции.",
      "Состояние Edge Functions отражено через HTTP-ответы Worker и последний system health task; версия функции не попадает в ежедневный отчёт.",
      "Проверены не более 100 последних запусков Actions и 50 открытых PR; статусы check runs собираются только для PR из этого репозитория и фиксированного списка проверок.",
      "Технический Analyst группирует только разрешённые коды событий; выводы являются гипотезами, а не подтверждённой первопричиной.",
    ],
  };
}

export function renderDailyReport(report) {
  const lines = [
    "# FAM — ежедневный отчёт агентов",
    "",
    "- Дата: " + report.report_date,
    "- Сформирован: " + report.generated_at,
    "",
    "## Источники",
    "",
    "- Supabase: " + report.sources.supabase,
    "- GitHub Actions: " + report.sources.github_actions,
    "- Открытые PR: " + report.sources.pull_requests,
    "- Production deployment: " + report.sources.production_deployment,
    "- Публичный сайт: " + report.sources.public_site,
  ];
  const snapshot = report.supabase;
  lines.push("", "## Роли", "",
    "| Роль | Состояние |",
    "|---|---|");
  for (const role of report.role_statuses) {
    lines.push("| " + safeLabel(role.role, 40) + " | " + safeLabel(role.status, 80) + " |");
  }
  lines.push("", "## Аналитические гипотезы по техническим сигналам", "");
  if (report.technical_analysis.status === "no_allowlisted_signals") {
    lines.push("Нет допустимых агрегированных сигналов за период.");
  } else {
    lines.push("Это гипотезы по кодам событий; точная причина без stack trace или дополнительных данных не устанавливается.");
    for (const finding of report.technical_analysis.findings) {
      lines.push("- " + safeLabel(finding.title, 80) + " (" + safeLabel(finding.page_area, 30) +
        "): " + count(finding.occurrences) + " событий, коды " +
        finding.event_codes.map((code) => safeLabel(code, 40)).join(", ") +
        ". Гипотеза: " + safeLabel(finding.hypothesis, 220) +
        " Проверить: " + safeLabel(finding.recommended_check, 220) + ".");
    }
  }
  lines.push("", "## Supabase и очередь", "");
  if (!snapshot) {
    lines.push("Снимок Supabase недоступен; данные не считаются успешными.");
  } else {
    lines.push("- Последняя ежедневная сводка: " +
      (snapshot.daily_report?.report_date ?? "нет") + " (создана: " +
      (snapshot.daily_report?.generated_at ?? "нет") + ").");
    lines.push("- Последняя техническая проверка: " +
      (snapshot.latest_system_health?.status ?? "нет данных") + " (" +
      (snapshot.latest_system_health?.updated_at ?? "время неизвестно") + ").");
    lines.push("- Последняя задача coder: " +
      (snapshot.latest_coder_task?.status ?? "нет данных") + " (" +
      (snapshot.latest_coder_task?.updated_at ?? "время неизвестно") + ").");
    lines.push("- Последняя проверка ошибок сайта: " +
      (snapshot.latest_site_error_check?.status ?? "нет данных") + " (" +
      (snapshot.latest_site_error_check?.updated_at ?? "время неизвестно") + ").");
    const workerHttp = snapshot.worker_http_6h;
    if (workerHttp && typeof workerHttp === "object") {
      lines.push("- Ответы Edge Worker по pg_net (окно до " + count(workerHttp.window_hours) + " ч): " +
        count(workerHttp.success_count) + "/" + count(workerHttp.response_count) +
        " успешных распознанных ответов; HTTP-ошибок: " + count(workerHttp.http_error_count) +
        "; ошибок, сообщённых Worker: " + count(workerHttp.reported_error_count) + ".");
      if (typeof workerHttp.observed_from === "string") {
        lines.push("  Самый ранний сохранённый ответ: " + safeLabel(workerHttp.observed_from, 40) + ".");
      }
    } else {
      lines.push("- Ответы Edge Worker по pg_net: нет данных.");
    }
    lines.push("", "| Агент | В очереди | В работе | Заблокировано | Готово за сутки | Ошибки за сутки |",
      "|---|---:|---:|---:|---:|---:|");
    for (const agent of snapshot.agent_statuses ?? []) {
      lines.push("| " + safeLabel(agent.agent_key, 40) + " | " + count(agent.queued) + " | " +
        count(agent.in_progress) + " | " + count(agent.blocked) + " | " +
        count(agent.completed_24h) + " | " + count(agent.failed_24h) + " |");
    }
    lines.push("", "### Cron", "",
      "| Задание | Расписание UTC | Активно | Последний результат | Последний запуск UTC |",
      "|---|---|---:|---|---|");
    for (const job of snapshot.cron_jobs ?? []) {
      lines.push("| " + safeLabel(job.jobname, 80) + " | " + safeLabel(job.schedule, 40) +
        " | " + (job.active === true ? "да" : "нет") + " | " +
        safeLabel(job.last_run_status ?? "нет данных", 40) + " | " +
        safeLabel(job.last_run_at ?? "нет данных", 40) + " |");
    }
  }

  lines.push("", "## Ошибки задач за последние 24 часа", "");
  if (!snapshot) {
    lines.push("Снимок Supabase недоступен.");
  } else if ((snapshot.failed_tasks_24h ?? []).length === 0) {
    lines.push("Не зафиксировано.");
  } else {
    for (const failure of snapshot.failed_tasks_24h) {
      lines.push("- " + safeLabel(failure.task_type, 80) + ": " + count(failure.count) +
        " сбоев; свободный текст причины не выгружался.");
    }
  }

  lines.push("", "## GitHub Actions за последние 24 часа", "");
  if (report.sources.github_actions !== "available") {
    lines.push("История запусков недоступна.");
  } else if (report.workflows_24h.length === 0) {
    lines.push("Запусков не найдено; это не считается ошибкой.");
  } else {
    for (const workflow of report.workflows_24h) {
      const latest = workflow.latest;
      const link = latest?.html_url ? " ([последний запуск](" + latest.html_url + "))" : "";
      lines.push("- " + workflow.name + ": всего " + workflow.total_24h +
        ", успешно " + workflow.success + ", ошибки " + workflow.failure +
        ", выполняется " + workflow.in_progress + ", ожидает " + workflow.queued +
        ", другие состояния " + workflow.other +
        (latest ? "; последнее состояние: " + latest.status + "/" + latest.conclusion : "") + link + ".");
    }
  }

  lines.push("", "## Pull Requests", "");
  if (report.sources.pull_requests !== "available") {
    lines.push("Список PR недоступен.");
  } else if (report.open_pull_requests.length === 0) {
    lines.push("Открытых PR нет.");
  } else {
    for (const pull of report.open_pull_requests) {
      const link = pull.html_url ? " ([открыть](" + pull.html_url + "))" : "";
      const checks = pull.checks?.checks?.length
        ? pull.checks.checks.map((check) => check.key + "=" + check.status).join(", ")
        : pull.checks?.status === "not_observed" ? "не наблюдались" : "недоступны";
      lines.push("- PR #" + pull.number + (pull.draft ? " — draft" : " — открыт") +
        "; проверки: " + checks + link + ".");
    }
  }

  lines.push("", "## Публикация и ограничения", "",
    "- Последний production deployment: " + report.production_deployment.status +
      (report.production_deployment.created_at ? " (" + report.production_deployment.created_at + ")" : "") +
      (report.production_deployment.html_url ? " — " + report.production_deployment.html_url : "") + ".",
    "- Публичный сайт: " + report.public_site.status +
      (report.public_site.http_status ? " (HTTP " + report.public_site.http_status + ")" : "") + ".",
    ...report.limitations.map((item) => "- " + item),
    "",
    "Отчёт использует агрегированные состояния. Он не объединяет PR, не меняет production и не отправляет уведомления.");
  return lines.join("\n") + "\n";
}

async function githubGet(url, token) {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function pullRequestsWithChecks(pulls, base, token, repository) {
  if (!Array.isArray(pulls)) return pulls;
  const selected = pulls.slice(0, 50);
  const checksByNumber = new Map();
  for (let start = 0; start < selected.length; start += 5) {
    const batch = selected.slice(start, start + 5);
    const results = await Promise.all(batch.map(async (pull) => {
      const sha = pull?.head?.sha;
      if (pull?.head?.repo?.full_name !== repository || typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
        return { number: pull?.number, check_runs: null };
      }
      const data = await githubGet(base + "/commits/" + sha + "/check-runs?per_page=100", token);
      return {
        number: pull.number,
        check_runs: Array.isArray(data?.check_runs) ? data.check_runs : null,
      };
    }));
    for (const result of results) checksByNumber.set(result.number, result.check_runs);
  }
  return selected.map((pull) => ({
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    html_url: pull.html_url,
    created_at: pull.created_at,
    check_runs: checksByNumber.get(pull.number) ?? null,
  }));
}

async function supabaseSnapshot(url, token) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fam-agent-token": token },
      body: JSON.stringify({ action: "report" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { status: "unavailable", snapshot: null };
    const data = await response.json();
    if (data?.ok !== true || !data.report || typeof data.report !== "object") {
      return { status: "invalid_response", snapshot: null };
    }
    return { status: "available", snapshot: data.report };
  } catch {
    return { status: "unavailable", snapshot: null };
  }
}

async function probePublicSite() {
  try {
    const response = await fetch(PUBLIC_SITE_URL, { signal: AbortSignal.timeout(10000) });
    return { status: response.ok ? "reachable" : "http_error", http_status: response.status };
  } catch {
    return { status: "unavailable", http_status: null };
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const bridgeUrl = process.env.FAM_AGENT_BRIDGE_URL ?? "";
  const bridgeToken = process.env.FAM_AGENT_WORKER_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new Error("Reporter is missing a valid repository or GitHub token.");
  }
  const base = API_ROOT + "/repos/" + repository;
  const [runData, pullData, deploymentData, snapshotData, siteProbe] = await Promise.all([
    githubGet(base + "/actions/runs?branch=main&per_page=100", token),
    githubGet(base + "/pulls?state=open&per_page=100", token),
    githubGet(base + "/deployments?environment=github-pages&per_page=5", token),
    bridgeUrl && bridgeToken
      ? supabaseSnapshot(bridgeUrl, bridgeToken)
      : Promise.resolve({ status: "not_configured", snapshot: null }),
    probePublicSite(),
  ]);

  const pullRequests = await pullRequestsWithChecks(pullData, base, token, repository);
  let production = { status: deploymentData ? "not_found" : "unavailable" };
  const deployment = Array.isArray(deploymentData) ? deploymentData[0] : null;
  if (deployment && Number.isSafeInteger(deployment.id)) {
    const statuses = await githubGet(base + "/deployments/" + deployment.id + "/statuses?per_page=1", token);
    const latest = Array.isArray(statuses) ? statuses[0] : null;
    production = {
      status: latest?.state ? safeLabel(latest.state, 40) : "unknown",
      created_at: typeof deployment.created_at === "string" ? deployment.created_at : null,
      html_url: safeGithubUrl(latest?.target_url ?? deployment.url),
    };
  }

  const now = new Date();
  const recentWorkflows = summarizeWorkflowRuns(runData?.workflow_runs ?? [], now);
  const latestCoderWorkflow = recentWorkflows
    .filter((workflow) => /local ai developer/i.test(workflow.name))
    .sort((a, b) => (b.latest?.created_at ?? "").localeCompare(a.latest?.created_at ?? ""))[0]?.latest;
  let agentJobsStatus = !Array.isArray(runData?.workflow_runs)
    ? "unavailable"
    : latestCoderWorkflow ? "unavailable" : "not_run_24h";
  let agentJobStatuses = null;
  if (Number.isSafeInteger(latestCoderWorkflow?.run_id)) {
    const jobsData = await githubGet(
      base + "/actions/runs/" + latestCoderWorkflow.run_id + "/jobs?per_page=100",
      token,
    );
    if (Array.isArray(jobsData?.jobs)) {
      agentJobsStatus = "available";
      agentJobStatuses = summarizeAgentJobStatuses(jobsData.jobs);
    }
  }
  const report = createDailyReport({
    snapshot: snapshotData.snapshot,
    snapshotStatus: snapshotData.status,
    workflowRuns: runData?.workflow_runs ?? [],
    workflowStatus: Array.isArray(runData?.workflow_runs) ? "available" : "unavailable",
    pullRequests,
    pullRequestStatus: Array.isArray(pullData) ? "available" : "unavailable",
    agentJobStatus: agentJobsStatus,
    agentJobStatuses,
    production,
    siteProbe,
    now,
  });
  if (!bridgeUrl || !bridgeToken) throw new Error("Private report storage is not configured.");
  const markdown = renderDailyReport(report);
  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fam-agent-token": bridgeToken },
    body: JSON.stringify({ action: "save_report", report_date: report.report_date, report: { ...report, markdown } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Private report storage failed.");
  const saved = await response.json();
  if (saved?.ok !== true || saved?.saved !== true) throw new Error("Private report storage did not confirm persistence.");
  console.log("FAM daily report stored privately in Supabase; report contents were not written to public logs.");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
