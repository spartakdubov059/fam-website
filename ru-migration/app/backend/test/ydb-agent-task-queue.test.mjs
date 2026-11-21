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
  assert.ok(insert.values.includes(JSON.stringify({ task_key: 'audit_frontend_runtime', event_code: 'js_runtime', page_area: 'other', occurrences: 4 })));
  await assert.rejects(queue.enqueueSafeCoderTask('2026-11-20T03:11'), /coder slot/);
});

test('coder producer caps 24-hour event aggregates to the bridge payload limit', async () => {
  const { sql, calls } = fakeSql(query => query.includes('SUM(event_count)')
    ? [[{ event_code: 'js_runtime', page_area: 'other', occurrences: 24_000 }]] : [[]]);
  const queue = createYdbAgentTaskQueue(sql);
  const result = await queue.enqueueSafeCoderTask('2026-11-20T03:30');
  const insert = calls.find(call => call.query.includes('INSERT INTO fam_agent_tasks'));
  const payload = JSON.parse(insert.values.find(value => typeof value === 'string' && value.includes('"task_key"')));
  assert.equal(result.created, true);
  assert.equal(payload.occurrences, 1000, 'payload remains within the coder bridge validation bound');
});

test('coder bridge claims only allowlisted aggregate payload and finishes the matching live lease', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const claimToken = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  let finished = false; let savedToken;
  const { sql } = fakeSql((query, values) => {
    calls.push(query);
    if (query.includes('SELECT id, payload_json')) return [[{ id,
      payload_json: JSON.stringify({ task_key: 'audit_frontend_runtime', event_code: 'js_runtime', page_area: 'other', occurrences: 7 }),
      status: 'queued', available: true, lease_expired: false }]];
    if (query.includes('SET status = Unwrap(CAST(') && query.includes('claim_token = ?')) savedToken = values[1];
    if (query.includes('SELECT status, claimed_by, claim_token')) return [[{ status: 'claimed',
      claimed_by: 'fam-agent-qwen-coder-v1', claim_token: savedToken, lease_valid: true }]];
    if (query.includes('finished_at = CASE')) finished = true;
    return [[]];
  });
  const queue = createYdbAgentTaskQueue(sql);
  const task = await queue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
  assert.deepEqual({ id: task.id, task_key: task.task_key, event_code: task.event_code,
    page_area: task.page_area, occurrences: task.occurrences },
  { id, task_key: 'audit_frontend_runtime', event_code: 'js_runtime', page_area: 'other', occurrences: 7 });
  assert.ok(calls.some(query => query.includes("task_type = 'coder_patch_request'")));
  assert.match(task.claim_token, /^[0-9a-f-]{36}$/i);
  assert.equal(await queue.finishSafeCoderTask({ id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: task.claim_token, resultCode: 'model_completed' }), true);
  assert.equal(finished, true);
  await assert.rejects(queue.claimSafeCoderTask({ workerId: 'wrong-worker', leaseSeconds: 7200 }), /coder worker claim/);
  await assert.rejects(queue.finishSafeCoderTask({ id, workerId: 'wrong-worker', claimToken, resultCode: 'model_completed' }), /coder task result/);
});

test('coder claim closes only its own expired final system lease and records a terminal event', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const claimToken = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const { sql } = fakeSql((query, values) => {
    calls.push({ query, values });
    if (query.includes('SELECT id, claim_token FROM fam_agent_tasks')) return [[{ id, claim_token: claimToken }]];
    return [[]];
  });
  const queue = createYdbAgentTaskQueue(sql);
  assert.equal(await queue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 }), null);
  const recovery = calls[0];
  assert.match(recovery.query, /source IN \('system', 'scheduled_audit'\)/);
  assert.match(recovery.query, /claimed_by = \?/);
  assert.match(recovery.query, /attempt_count >= max_attempts/);
  const update = calls.find(call => call.query.includes("SET status = Unwrap(CAST('failed'"));
  assert.ok(update);
  assert.ok(update.query.includes('claim_token = ?'));
  assert.deepEqual(update.values.slice(0, 2), [
    'Локальный анализатор исчерпал число попыток после истечения аренды.', id,
  ]);
  assert.ok(calls.some(call => call.query.includes('INSERT INTO fam_agent_task_events')
    && call.query.includes('Задача закрыта после истечения аренды последней разрешённой попытки.')));
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
  const claimUpdate = calls.find(call => call.query.includes("UPDATE fam_agent_tasks SET status = Unwrap(CAST('claimed'"));
  assert.match(claimUpdate.query, /finished_at = CAST\(NULL AS Timestamp\?\)/,
    'a reclaimed task restarts its terminal-retention clock');
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
