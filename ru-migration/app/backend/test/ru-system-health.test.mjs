import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuSystemHealthReport } from '../services/ru-system-health.mjs';
import { checkRuSystemHealth } from '../check-ru-system-health.mjs';

const readiness = { ready: true, services: { auth: true, database: true, objectStorage: true } };
const timers = { ok: true, timers: [
  { unit: 'fam-ru-runtime-health.timer', ok: true },
  { unit: 'fam-ru-school-agent-report.timer', ok: true },
] };
const schemaHealth = { ok: true, tables_checked: 38, content_read: false, write_permissions_checked: false };
const queueHealth = { content_read: false, queues: {
  daily_reports: { statuses: { queued: 1, claimed: 0, completed: 5, blocked: 0, failed: 0 }, expired_leases: 0,
    failed_or_blocked_24h: 0, oldest_queued_age_minutes: 10 },
  site_error_digests: { statuses: { queued: 0, claimed: 0, completed: 8, blocked: 0, failed: 0 }, expired_leases: 0,
    failed_or_blocked_24h: 0, oldest_queued_age_minutes: 0 },
  safe_agent_tasks: { statuses: { queued: 0, claimed: 0, completed: 0, blocked: 0, failed: 0 }, expired_leases: 0,
    failed_or_blocked_24h: 0, oldest_queued_age_minutes: 0 },
} };

test('system health combines readiness, timer status and aggregate queues without exposing task content', () => {
  const report = buildRuSystemHealthReport({ readiness, timers, backgroundQueueHealth: queueHealth, schemaHealth });
  assert.equal(report.ok, true);
  assert.equal(report.readiness.ok, true);
  assert.equal(report.timers.ok, true);
  assert.equal(report.schema.tablesChecked, 38);
  assert.equal(report.queues.dailyReports.queued, 1);
  assert.equal(report.queues.safeAgentTasks.ok, true);
  assert.equal(report.contentRead, false);
  assert.equal(JSON.stringify(report).includes('payload'), false);
  assert.equal(JSON.stringify(report).includes('student'), false);
});

test('system health fails for missing services, unhealthy timers, stale queues and recent failures', () => {
  const degraded = structuredClone(queueHealth);
  degraded.queues.daily_reports.expired_leases = 1;
  degraded.queues.site_error_digests.failed_or_blocked_24h = 1;
  degraded.queues.site_error_digests.oldest_queued_age_minutes = 91;
  degraded.queues.safe_agent_tasks.failed_or_blocked_24h = 1;
  const report = buildRuSystemHealthReport({
    readiness: { ready: false, services: { auth: true, database: false, objectStorage: true } },
    timers: { ok: false, timers: [{ unit: 'fam-ru-runtime-health.timer', ok: false }] },
    backgroundQueueHealth: degraded, schemaHealth,
  });
  assert.equal(report.ok, false);
  assert.equal(report.readiness.database, false);
  assert.equal(report.timers.ok, false);
  assert.equal(report.queues.dailyReports.ok, false);
  assert.equal(report.queues.siteErrorDigests.ok, false);
  assert.equal(report.queues.safeAgentTasks.ok, false);
});

test('system health rejects empty, inconsistent, or duplicate timer reports even when aggregate ok is true', () => {
  for (const timerReport of [
    { ok: true, timers: [] },
    { ok: true, timers: [null] },
    { ok: true, timers: [{ unit: 'fam-ru-runtime-health.timer', ok: false }] },
    { ok: true, timers: [
      { unit: 'fam-ru-runtime-health.timer', ok: true },
      { unit: 'fam-ru-runtime-health.timer', ok: true },
    ] },
  ]) {
    const report = buildRuSystemHealthReport({ readiness, timers: timerReport, backgroundQueueHealth: queueHealth, schemaHealth });
    assert.equal(report.ok, false);
    assert.equal(report.timers.ok, false);
  }
});

test('system health closes its database runtime even when an aggregate read fails', async () => {
  let closed = false;
  const report = await checkRuSystemHealth({
    readinessCheck: async () => readiness,
    timerCheck: () => timers,
    runtimeFactory: async () => ({
      getRuBackgroundQueueHealth: async () => { throw new Error('synthetic unavailable'); },
      getRuSchemaHealth: async () => schemaHealth,
      close: async () => { closed = true; },
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.queues.ok, false);
  assert.equal(closed, true);
});

test('system health turns readiness probe errors into a generic degraded result', async () => {
  const report = await checkRuSystemHealth({
    readinessCheck: async () => { throw new Error('synthetic unavailable'); },
    timerCheck: () => timers,
    runtimeFactory: async () => ({
      getRuBackgroundQueueHealth: async () => queueHealth,
      getRuSchemaHealth: async () => schemaHealth,
      close: async () => {},
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.readiness.ok, false);
  assert.equal(JSON.stringify(report).includes('synthetic unavailable'), false);
});

test('system health fails closed when RU schema tables are unavailable or unverified', () => {
  for (const invalid of [null, { ...schemaHealth, ok: false }, { ...schemaHealth, tables_checked: 0 },
    { ...schemaHealth, content_read: true }, { ...schemaHealth, write_permissions_checked: true }]) {
    const report = buildRuSystemHealthReport({ readiness, timers, backgroundQueueHealth: queueHealth, schemaHealth: invalid });
    assert.equal(report.ok, false);
    assert.equal(report.schema.ok, false);
  }
});
