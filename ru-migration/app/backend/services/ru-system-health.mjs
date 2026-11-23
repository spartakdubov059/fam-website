const STATUS_KEYS = ['queued', 'claimed', 'completed', 'blocked', 'failed'];

function inspectQueue(queue, maxAgeMinutes) {
  const statuses = queue?.statuses;
  const validStatuses = statuses && STATUS_KEYS.every(key => Number.isSafeInteger(statuses[key]) && statuses[key] >= 0);
  const expiredLeases = Number.isSafeInteger(queue?.expired_leases) && queue.expired_leases >= 0;
  const recentFailures = Number.isSafeInteger(queue?.failed_or_blocked_24h) && queue.failed_or_blocked_24h >= 0;
  const age = Number.isSafeInteger(queue?.oldest_queued_age_minutes) && queue.oldest_queued_age_minutes >= 0;
  const ok = validStatuses && expiredLeases && recentFailures && age
    && queue.expired_leases === 0 && queue.failed_or_blocked_24h === 0
    && queue.oldest_queued_age_minutes <= maxAgeMinutes;
  return {
    ok: Boolean(ok),
    queued: validStatuses ? statuses.queued : 0,
    claimed: validStatuses ? statuses.claimed : 0,
    completed: validStatuses ? statuses.completed : 0,
    blocked: validStatuses ? statuses.blocked : 0,
    failed: validStatuses ? statuses.failed : 0,
    expiredLeases: expiredLeases ? queue.expired_leases : 0,
    failedOrBlocked24h: recentFailures ? queue.failed_or_blocked_24h : 0,
    oldestQueuedAgeMinutes: age ? queue.oldest_queued_age_minutes : 0,
  };
}

export function buildRuSystemHealthReport({ readiness, timers, backgroundQueueHealth, schemaHealth }) {
  const schemaOk = schemaHealth?.ok === true && Number.isSafeInteger(schemaHealth.tables_checked)
    && schemaHealth.tables_checked > 0 && schemaHealth.content_read === false
    && schemaHealth.write_permissions_checked === false;
  const readinessOk = readiness?.ready === true && readiness?.services?.auth === true
    && readiness?.services?.database === true && readiness?.services?.objectStorage === true;
  const timerStates = timers && Array.isArray(timers.timers) ? timers.timers : [];
  const timerNames = timerStates.map(timer => timer?.unit);
  const timersValid = timerStates.length > 0
    && timerStates.every(timer => typeof timer?.unit === 'string' && timer.unit !== '' && timer.ok === true)
    && new Set(timerNames).size === timerNames.length;
  const timerReport = timers && Array.isArray(timers.timers)
    ? { ok: timers.ok === true && timersValid, timers: timers.timers.map(timer => ({
      unit: typeof timer?.unit === 'string' && timer.unit !== '' ? timer.unit : null,
      ok: timer?.ok === true,
    })) }
    : { ok: false, timers: [] };
  const queues = backgroundQueueHealth?.content_read === false && backgroundQueueHealth?.queues
    ? {
      dailyReports: inspectQueue(backgroundQueueHealth.queues.daily_reports, 26 * 60),
      siteErrorDigests: inspectQueue(backgroundQueueHealth.queues.site_error_digests, 30),
      safeAgentTasks: inspectQueue(backgroundQueueHealth.queues.safe_agent_tasks, 120),
    }
    : { dailyReports: inspectQueue(null, 26 * 60), siteErrorDigests: inspectQueue(null, 30), safeAgentTasks: inspectQueue(null, 120) };
  const queuesOk = queues.dailyReports.ok && queues.siteErrorDigests.ok && queues.safeAgentTasks.ok;
  return {
    ok: readinessOk && timerReport.ok && queuesOk && schemaOk,
    readiness: { ok: readinessOk, auth: readiness?.services?.auth === true,
      database: readiness?.services?.database === true, objectStorage: readiness?.services?.objectStorage === true },
    timers: timerReport,
    schema: { ok: schemaOk, tablesChecked: schemaHealth?.content_read === false
      && Number.isSafeInteger(schemaHealth.tables_checked) && schemaHealth.tables_checked >= 0
      ? schemaHealth.tables_checked : 0 },
    queues: { ok: queuesOk, ...queues },
    contentRead: false,
  };
}
