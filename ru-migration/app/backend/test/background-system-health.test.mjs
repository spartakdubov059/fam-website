import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundSystemHealthTask } from '../services/background-system-health.mjs';

const queue = () => ({ statuses: { queued: 0, claimed: 0, completed: 5, blocked: 0, failed: 0 },
  expired_leases: 0, failed_or_blocked_24h: 0, oldest_queued_age_minutes: 0 });
const queues = () => ({ content_read: false, queues: {
  daily_reports: queue(), site_error_digests: queue(), safe_agent_tasks: { ...queue(), content_read: false },
} });
const schema = { ok: true, tables_checked: 38, content_read: false, write_permissions_checked: false };

test('background health checks database, schema and aggregate queues without claiming auth or scheduler health', async () => {
  const calls = [];
  const health = createBackgroundSystemHealthTask({
    databaseCheck: async () => { calls.push('database'); return true; },
    schemaCheck: async () => { calls.push('schema'); return schema; },
    queueHealthCheck: async () => { calls.push('queues'); return queues(); },
  });
  const summary = await health();
  assert.deepEqual(calls.sort(), ['database', 'queues', 'schema']);
  assert.match(summary, /база доступна; схем проверено 38; очереди: 3\/3/);
  assert.match(summary, /состояние расписаний и OAuth .*не проверяется/i);
  assert.doesNotMatch(summary, /payload|ученик|email/i);
});

test('background health fails closed when database, schema, or any queue is unhealthy', async () => {
  const cases = [
    { database: false, schema, queues: queues() },
    { database: true, schema: { ...schema, ok: false }, queues: queues() },
    { database: true, schema, queues: { ...queues(), content_read: true } },
    { database: true, schema, queues: { ...queues(), queues: { ...queues().queues,
      site_error_digests: { ...queue(), failed_or_blocked_24h: 1 } } } },
  ];
  for (const input of cases) {
    const health = createBackgroundSystemHealthTask({ databaseCheck: async () => input.database,
      schemaCheck: async () => input.schema, queueHealthCheck: async () => input.queues });
    await assert.rejects(health(), /background_system_health_degraded/);
  }
});

test('background health rejects queues with missing or invalid aggregate fields', async () => {
  const health = createBackgroundSystemHealthTask({ databaseCheck: async () => true,
    schemaCheck: async () => schema, queueHealthCheck: async () => ({ content_read: false, queues: {
      daily_reports: queue(), site_error_digests: queue(), safe_agent_tasks: { content_read: false },
    } }) });
  await assert.rejects(health(), /background_system_health_degraded/);
});

test('background health flags a site-error queue older than two 15-minute intervals', async () => {
  const staleQueues = queues();
  staleQueues.queues.site_error_digests.oldest_queued_age_minutes = 31;
  const health = createBackgroundSystemHealthTask({ databaseCheck: async () => true,
    schemaCheck: async () => schema, queueHealthCheck: async () => staleQueues });
  await assert.rejects(health(), /background_system_health_degraded/);
});
