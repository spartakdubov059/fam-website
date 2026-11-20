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

export function buildRuSystemHealthReport({ readiness, timers, backgroundQueueHealth }) {
  const readinessOk = readiness?.ready === true && readiness?.services?.auth === true
    && readiness?.services?.database === true && readiness?.services?.objectStorage === true;
  const timerReport = timers && Array.isArray(timers.timers)
    ? { ok: timers.ok === true, timers: timers.timers.map(timer => ({
      unit: timer.unit,
      ok: timer.ok === true,
    })) }
    : { ok: false, timers: [] };
  const queues = backgroundQueueHealth?.content_read === false && backgroundQueueHealth?.queues
    ? {
      dailyReports: inspectQueue(backgroundQueueHealth.queues.daily_reports, 26 * 60),
      siteErrorDigests: inspectQueue(backgroundQueueHealth.queues.site_error_digests, 120),
    }
    : { dailyReports: inspectQueue(null, 26 * 60), siteErrorDigests: inspectQueue(null, 120) };
  const queuesOk = queues.dailyReports.ok && queues.siteErrorDigests.ok;
  return {
    ok: readinessOk && timerReport.ok && queuesOk,
    readiness: { ok: readinessOk, auth: readiness?.services?.auth === true,
      database: readiness?.services?.database === true, objectStorage: readiness?.services?.objectStorage === true },
    timers: timerReport,
    queues: { ok: queuesOk, ...queues },
    contentRead: false,
  };
}
