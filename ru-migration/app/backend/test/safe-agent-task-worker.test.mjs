import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeAgentTaskWorker } from '../services/safe-agent-task-worker.mjs';

const task = (task_type, id = '11111111-1111-4111-8111-111111111111') => ({
  id, task_type, claim_token: '22222222-2222-4222-8222-222222222222',
});

test('safe agent worker processes allowlisted aggregate tasks and records no content', async () => {
  const finished = []; const called = [];
  const worker = createSafeAgentTaskWorker({
    queue: { claimSafeTasks: async limit => { assert.equal(limit, 3); return [task('queue_health_check')]; },
      finishSafeTask: async result => { finished.push(result); return true; } },
    handlers: { queue_health_check: async () => { called.push('queue'); return 'Только агрегированные статусы очередей.'; } },
  });
  assert.deepEqual(await worker(), { claimed: 1, completed: 1, blocked: 0, failed: 0, content_read: false, worker_id: 'fam-ru-safe-worker-v1' });
  assert.deepEqual(called, ['queue']);
  assert.equal(finished[0].status, 'completed');
  assert.equal(finished[0].summary, 'Только агрегированные статусы очередей.');
});

test('safe agent worker blocks an unknown task without invoking a handler', async () => {
  const finished = [];
  const worker = createSafeAgentTaskWorker({
    queue: { claimSafeTasks: async () => [task('coder_patch_request')], finishSafeTask: async result => { finished.push(result); return true; } },
    handlers: { coder_patch_request: async () => { throw new Error('must not run'); } },
  });
  assert.equal((await worker()).blocked, 1);
  assert.match(finished[0].summary, /не входит в разрешённый список/);
});

test('safe agent worker stores a fixed error summary and does not leak handler errors', async () => {
  const finished = [];
  const worker = createSafeAgentTaskWorker({
    queue: { claimSafeTasks: async () => [task('daily_report_digest')], finishSafeTask: async result => { finished.push(result); return true; } },
    handlers: { daily_report_digest: async () => { throw new Error('sensitive query text'); } },
  });
  assert.equal((await worker()).failed, 1);
  assert.doesNotMatch(finished[0].summary, /sensitive/);
});

test('safe agent worker validates the batch size before claiming', async () => {
  let called = false;
  const worker = createSafeAgentTaskWorker({ queue: { claimSafeTasks: async () => { called = true; return []; }, finishSafeTask() {} }, handlers: {} });
  await assert.rejects(worker(6), /limit/);
  assert.equal(called, false);
});
