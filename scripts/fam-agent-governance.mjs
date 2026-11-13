import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPORT_MARKER = "<!-- fam-governance-control-tower-v1 -->";
const DAY = 86_400_000;
const MAX_PRS = 25;
const CORE_WORKFLOW = "fam-codex-developer.yml";

function dateMs(value) {
  const result = Date.parse(value || "");
  return Number.isFinite(result) ? result : 0;
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

export function proposeRecruitment({ disputes = [], warnings = [] } = {}) {
  const proposals = [];
  if (disputes.length >= 3) {
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

export function makeReport({ disputes = [], warnings = [], proposals = [], count = 0, limited = false, now = Date.now() } = {}) {
  const lines = [
    REPORT_MARKER,
    "# FAM — штаб контроля агентов",
    "",
    "Отчёт на " + new Date(now).toISOString().slice(0, 16).replace("T", " ") + " UTC.",
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
  lines.push("", "## INSPECTOR — эффективность и простой");
  if (!warnings.length) lines.push("Подтверждённых технических сигналов в проверенной выборке нет.");
  for (const w of warnings) {
    lines.push("- [" + clean(w.severity) + "] " + clean(w.message) +
      "; случаев: " + w.count +
      (w.prs?.length ? "; PR: " + w.prs.map((n) => "#" + n).join(", ") : ""));
  }
  lines.push("", "## RECRUITER — предложения по найму");
  if (!proposals.length) lines.push("Нет достаточных оснований создавать новые роли.");
  for (const p of proposals) {
    lines.push("- **" + clean(p.role) + "**: " + clean(p.reason, 300) +
      ". Права: " + clean(p.permissions, 250) + ".");
  }
  lines.push("", "## Полномочия и ограничения",
    "- Сигналы основаны на метаданных GitHub, не на частных сообщениях пользователей.",
    "- Пересечение файлов — возможный конфликт, а не доказательство ошибки разработчика.",
    "- Отсутствие задач или ручное ожидание PR не равно бездействию агента.",
    "- RECRUITER только рекомендует новый профиль агента: создавать, включать, отключать и оплачивать агентов без одобрения владельца запрещено.",
    "- Этот процесс не имеет прав менять код, закрывать PR, выполнять merge или публиковать сайт.",
    "");
  return lines.join("\n");
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
  const title = "FAM: контроль конфликтов, работоспособности и найма агентов";
  if (found) {
    await api("/issues/" + found.number, token, {
      method: "PATCH",
      body: JSON.stringify({ body: report }),
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
  const disputes = findDisputes(pulls);
  const warnings = inspectAgents({ pulls, coderRuns: workflows.workflow_runs });
  const proposals = proposeRecruitment({ disputes, warnings });
  const report = makeReport({
    disputes, warnings, proposals, count: selected.length,
    limited: prs.length > selected.length || pulls.some((p) => p.files === null),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  }
  process.stdout.write("FAM governance: конфликтов " + disputes.length +
    ", предупреждений " + warnings.length + ", предложений " + proposals.length + "\n");
  if (disputes.length || warnings.length || proposals.length) {
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
