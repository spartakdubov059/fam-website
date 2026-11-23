import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledSafeAgentRunner, createScheduledCoderTaskProducer, getDueSafeAgentTasks } from '../services/scheduled-safe-agent-runner.mjs';

test('safe agent schedule follows UTC source slots and ignores other times', () => {
  assert.deepEqual(getDueSafeAgentTasks('2026-11-20T03:40:00Z'), ['system_health_check']);
  assert.deepEqual(getDueSafeAgentTasks('2026-11-20T04:00:00Z'), ['daily_report_digest']);
  for (const minute of ['00', '15', '45']) {
    assert.deepEqual(getDueSafeAgentTasks(`2026-11-20T05:${minute}:00Z`), []);
  }
  for (const minute of ['30']) {
    assert.deepEqual(getDueSafeAgentTasks(`2026-11-20T05:${minute}:00Z`), ['site_error_digest']);
  }
  assert.deepEqual(getDueSafeAgentTasks('2026-11-20T04:35:00Z'), []);
  assert.throws(() => getDueSafeAgentTasks('not-a-date'), /schedule time/);
});

test('scheduled worker idempotently enqueues due work before claiming and records only counts', async () => {
  const calls = [];
  const runner = createScheduledSafeAgentRunner({
    queue: { enqueueSafeTask: async (...args) => { calls.push(args); return { created: calls.length === 1 }; } },
    worker: async limit => { calls.push(['worker', limit]); return { claimed: 1, completed: 1, blocked: 0, failed: 0, content_read: false }; },
    now: () => new Date('2026-11-20T03:40:00Z'),
  });
  assert.deepEqual(await runner(), { claimed: 1, completed: 1, blocked: 0, failed: 0, content_read: false, scheduled: 1, created: 1 });
  assert.deepEqual(calls, [['system_health_check', '2026-11-20T03:40'], ['worker', 3]]);
});

test('scheduled runner enqueues the site error digest only at the upstream UTC minute-30 slot', async () => {
  for (const minute of ['30']) {
    const calls = [];
    const runner = createScheduledSafeAgentRunner({
      queue: { enqueueSafeTask: async (...args) => { calls.push(args); return { created: true }; } },
      worker: async () => ({ claimed: 0, completed: 0, blocked: 0, failed: 0, content_read: false }),
      now: () => new Date(`2026-11-20T05:${minute}:00Z`),
    });
    await runner();
    assert.deepEqual(calls, [['site_error_digest', `2026-11-20T05:${minute}`]]);
  }
  assert.deepEqual(getDueSafeAgentTasks('2026-11-20T05:15:00Z'), []);
  assert.deepEqual(getDueSafeAgentTasks('2026-11-20T05:45:00Z'), []);
});

test('coder producer enqueues only bounded quarter-hour slots without reading user content', async () => {
  const calls = [];
  const produce = createScheduledCoderTaskProducer({ repository: {
    enqueueSafeCoderTask: async slot => { calls.push(slot); return { created: true }; },
  }, now: () => new Date('2026-11-20T03:10:00Z') });
  assert.deepEqual(await produce(), { created: true, reason: 'queued_for_manual_review', content_read: false });
  assert.deepEqual(calls, ['2026-11-20T03:00']);
});
