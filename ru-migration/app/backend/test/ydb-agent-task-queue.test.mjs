import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbAgentTaskQueue } from '../repositories/ydb-agent-task-queue.mjs';

function fakeSql(respond) {
  const calls = [];
  const sql = (strings, ...values) => {
    const query = strings.join('?'); calls.push({ query, values });
    return Promise.resolve(respond(query, values));
  };
  sql.begin = callback => callback(sql);
  return { sql, calls };
}

test('safe task enqueue is idempotent and accepts only fixed task types and UTC slots', async () => {
  let exists = false;
  const { sql, calls } = fakeSql((query) => {
    if (query.includes('SELECT status FROM fam_agent_tasks')) return exists ? [[{ status: 'queued' }]] : [[]];
    if (query.includes('INSERT INTO fam_agent_tasks')) exists = true;
    return [[]];
  });
  const queue = createYdbAgentTaskQueue(sql);
  const first = await queue.enqueueSafeTask('queue_health_check', '2026-11-20T03:00');
  const second = await queue.enqueueSafeTask('queue_health_check', '2026-11-20T03:00');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.equal(calls.filter(call => call.query.includes('INSERT INTO fam_agent_tasks')).length, 1);
  await assert.rejects(queue.enqueueSafeTask('coder_patch_request', '2026-11-20T03:00'), /safe agent task/);
  await assert.rejects(queue.enqueueSafeTask('queue_health_check', '2026-11-20T03:07'), /safe agent task/);
});

test('coder producer creates only one bounded task from allowlisted aggregate events', async () => {
  let inserted = false;
  const { sql, calls } = fakeSql(query => {
    if (query.includes('SELECT status FROM fam_agent_tasks')) return inserted ? [[{ status: 'blocked' }]] : [[]];
    if (query.includes("task_type = 'coder_patch_request'")) return inserted ? [[{ id: '33333333-3333-4333-8333-333333333333' }]] : [[]];
    if (query.includes('SUM(event_count)')) return [[{ event_code: 'js_runtime', page_area: 'other', occurrences: 4 }]];
    if (query.includes('INSERT INTO fam_agent_tasks') && query.includes('VALUES')) inserted = true;
    return [[]];
  });
  const queue = createYdbAgentTaskQueue(sql);
  const first = await queue.enqueueSafeCoderTask('2026-11-20T03:15');
  const second = await queue.enqueueSafeCoderTask('2026-11-20T03:15');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.task_key, 'audit_frontend_runtime');
  const insert = calls.find(call => call.query.includes('INSERT INTO fam_agent_tasks') && call.query.includes('VALUES'));
  assert.ok(insert);
  assert.match(insert.query, /payload_json/);
  await assert.rejects(queue.enqueueSafeCoderTask('2026-11-20T03:11'), /coder slot/);
});

test('safe task enqueue binds task values and writes a minimal empty payload', async () => {
  const { sql, calls } = fakeSql(() => [[]]);
  const queue = createYdbAgentTaskQueue(sql);
  await queue.enqueueSafeTask('site_error_digest', '2026-11-20T03:15');
  const insert = calls.find(call => call.query.includes('INSERT INTO fam_agent_tasks'));
  assert.ok(insert);
  assert.ok(insert.values.includes('site_error_digest'));
  assert.ok(!insert.values.some(value => typeof value === 'string' && /student|email|message text/i.test(value)));
  assert.match(insert.query, /payload_json, result_summary/);
});

test('task claim filters to the safe allowlist and returns only task metadata', async () => {
  const { sql, calls } = fakeSql(query => query.includes('SELECT id, agent_key, task_type')
    ? [[{ id: '11111111-1111-4111-8111-111111111111', agent_key: 'quality', task_type: 'queue_health_check',
      approval_required: false, status: 'queued', attempt_count: 0, max_attempts: 3, available: true, lease_expired: true }]]
    : [[]]);
  const queue = createYdbAgentTaskQueue(sql);
  const [claimed] = await queue.claimSafeTasks(2);
  assert.equal(claimed.task_type, 'queue_health_check');
  assert.equal(claimed.agent_key, 'quality');
  assert.equal(claimed.claim_token.length, 36);
  assert.equal(Object.hasOwn(claimed, 'payload'), false);
  const select = calls.find(call => call.query.includes('SELECT id, agent_key, task_type'));
  assert.match(select.query, /approval_required = false/);
  assert.match(select.query, /'queue_health_check'.*'daily_report_digest'.*'system_health_check'.*'site_error_digest'/);
  assert.equal(select.query.includes('payload_json'), false);
});

test('task finish rejects invalid inputs and refuses an expired or mismatched lease', async () => {
  let validLease = false;
  const { sql, calls } = fakeSql(query => query.includes('SELECT status, claimed_by, claim_token')
    ? [[{ status: 'claimed', claimed_by: 'fam-ru-safe-worker-v1', claim_token: '22222222-2222-4222-8222-222222222222', lease_valid: validLease }]]
    : [[]]);
  const queue = createYdbAgentTaskQueue(sql);
  const result = { id: '11111111-1111-4111-8111-111111111111', claimToken: '22222222-2222-4222-8222-222222222222',
    status: 'completed', summary: 'Агрегированная проверка завершена.' };
  assert.equal(await queue.finishSafeTask(result), false);
  validLease = true;
  assert.equal(await queue.finishSafeTask(result), true);
  assert.ok(calls.some(call => call.query.includes('INSERT INTO fam_agent_task_events') && call.values.includes(result.summary)));
  await assert.rejects(queue.finishSafeTask({ ...result, status: 'cancelled' }), /safe agent task result/);
  await assert.rejects(queue.finishSafeTask({ ...result, summary: 'x'.repeat(1001) }), /safe agent task result/);
});
