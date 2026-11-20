import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHealthTaskHandler } from '../services/system-health-task.mjs';

const readiness = { ready: true, services: { auth: true, database: true, objectStorage: true } };
const timers = { ok: true, timers: [{ unit: 'fam-ru-runtime-health.timer', ok: true }] };
const queue = { content_read: false, queues: {
  daily_reports: { statuses: { queued: 0, claimed: 0, completed: 2, blocked: 0, failed: 0 }, expired_leases: 0, failed_or_blocked_24h: 0, oldest_queued_age_minutes: 0 },
  site_error_digests: { statuses: { queued: 0, claimed: 0, completed: 2, blocked: 0, failed: 0 }, expired_leases: 0, failed_or_blocked_24h: 0, oldest_queued_age_minutes: 0 },
  safe_agent_tasks: { statuses: { queued: 0, claimed: 0, completed: 2, blocked: 0, failed: 0 }, expired_leases: 0, failed_or_blocked_24h: 0, oldest_queued_age_minutes: 0, content_read: false },
} };

test('scheduled system health checks readiness, timers and aggregate queues without returning task content', async () => {
  const calls = [];
  const handler = createSystemHealthTaskHandler({
    readinessCheck: async () => { calls.push('readiness'); return readiness; },
    timerCheck: async () => { calls.push('timers'); return timers; },
    queueHealthCheck: async () => { calls.push('queues'); return queue; },
  });
  const summary = await handler();
  assert.deepEqual(calls.sort(), ['queues', 'readiness', 'timers']);
  assert.match(summary, /расписания — 1\/1; очереди — 3\/3/);
  assert.doesNotMatch(summary, /payload|student|ученик/i);
});

test('scheduled system health fails closed when a service, timer or queue is degraded', async () => {
  for (const inputs of [
    { readiness: { ...readiness, ready: false }, timers, queue },
    { readiness, timers: { ...timers, ok: false }, queue },
    { readiness, timers, queue: { ...queue, queues: { ...queue.queues,
      daily_reports: { ...queue.queues.daily_reports, failed_or_blocked_24h: 1 } } } },
  ]) {
    const handler = createSystemHealthTaskHandler({
      readinessCheck: async () => inputs.readiness,
      timerCheck: async () => inputs.timers,
      queueHealthCheck: async () => inputs.queue,
    });
    await assert.rejects(handler(), /system_health_degraded/);
  }
});
