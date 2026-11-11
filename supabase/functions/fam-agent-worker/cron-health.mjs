const EXPECTED_CRON_JOBS = new Map([
  ["fam-agent-worker-every-5-minutes", 15 * 60 * 1000],
  ["fam-agent-school-daily-report", 30 * 60 * 60 * 1000],
  ["fam-agent-orchestrator-daily-digest", 30 * 60 * 60 * 1000],
  ["fam-agent-technical-system-health", 30 * 60 * 60 * 1000],
  ["fam-agent-site-error-audit", 3 * 60 * 60 * 1000],
]);

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function addIssue(issues, job, reason) {
  issues.push({ job, reason });
}

/**
 * Check the latest actual pg_cron execution for every expected FAM operational job.
 * The database RPC already checks that jobs are present, enabled, and use the expected
 * schedule; this function additionally checks that their latest runs succeeded and are fresh.
 */
export function analyzeCronRunHealth(jobs, nowMs = Date.now()) {
  const issues = [];
  const rows = Array.isArray(jobs) ? jobs : [];
  const byName = new Map();

  for (const row of rows) {
    const name = typeof row?.job === "string" ? row.job : "";
    if (!name) {
      addIssue(issues, "unknown", "строка расписания не содержит имени");
      continue;
    }
    const current = byName.get(name) ?? [];
    current.push(row);
    byName.set(name, current);
  }

  for (const [name, maxAgeMs] of EXPECTED_CRON_JOBS) {
    const matches = byName.get(name) ?? [];
    if (matches.length === 0) {
      addIssue(issues, name, "расписание отсутствует в отчёте");
      continue;
    }
    if (matches.length > 1) {
      addIssue(issues, name, "расписание дублируется в отчёте");
    }

    const row = matches[0];
    if (row.active !== true) addIssue(issues, name, "расписание выключено");
    if (row.schedule_matches !== true) addIssue(issues, name, "фактическое расписание не совпадает с ожидаемым");

    if (row.last_run_status !== "succeeded") {
      const status = typeof row.last_run_status === "string" && row.last_run_status
        ? row.last_run_status
        : "нет данных";
      addIssue(issues, name, "последний запуск не подтверждён успешно (" + status + ")");
    }

    const lastRunMs = typeof row.last_run_at === "string" || typeof row.last_run_at === "number"
      ? Date.parse(row.last_run_at)
      : NaN;
    if (!Number.isFinite(lastRunMs)) {
      addIssue(issues, name, "время последнего запуска отсутствует или некорректно");
      continue;
    }

    const ageMs = nowMs - lastRunMs;
    if (ageMs < -MAX_CLOCK_SKEW_MS) {
      addIssue(issues, name, "время последнего запуска находится в будущем");
    } else if (ageMs > maxAgeMs) {
      addIssue(issues, name, "последний запуск устарел");
    }
  }

  for (const name of byName.keys()) {
    if (!EXPECTED_CRON_JOBS.has(name)) {
      addIssue(issues, name, "неизвестное расписание не входит в проверяемый список");
    }
  }

  const successful = EXPECTED_CRON_JOBS.size - new Set(issues.map((issue) => issue.job)).size;
  return {
    ok: issues.length === 0,
    checked: EXPECTED_CRON_JOBS.size,
    successful: Math.max(0, successful),
    issues,
  };
}
