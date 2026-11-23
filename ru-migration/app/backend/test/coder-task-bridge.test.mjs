import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoderTaskBridge } from '../services/coder-task-bridge.mjs';

const token = 'local-worker-token-that-is-at-least-32-bytes-long';
const lifecycleStub = { startSafeCoderTask: async () => false, heartbeatSafeCoderTask: async () => false,
  advanceSafeCoderTask: async () => false };
function request(body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return { method: 'POST', headers: { 'content-length': String(bytes.length), 'x-fam-agent-token': token, ...headers },
    async *[Symbol.asyncIterator]() { yield bytes; } };
}

test('coder bridge is closed without a strong worker token and rejects browser origins', async () => {
  const queue = { ...lifecycleStub, claimSafeCoderTask: async () => null, finishSafeCoderTask: async () => false,
    getAgentTaskQueueHealth: async () => ({ queued: 0, claimed: 0, in_progress: 0, failed_last_24h: 0, expired_leases: 0, oldest_queued_minutes: 0 }) };
  assert.equal((await createCoderTaskBridge({ queue, token: 'short' })(request({ action: 'claim' }))).status, 503);
  const bridge = createCoderTaskBridge({ queue, token });
  assert.equal((await bridge(request({ action: 'claim' }, { origin: 'https://example.test' }))).status, 403);
  assert.equal((await bridge(request({ action: 'claim' }, { 'x-fam-agent-token': 'wrong-token' }))).status, 401);
  assert.equal((await bridge({ ...request({ action: 'claim' }), method: 'GET' })).status, 405);
});

test('coder bridge returns only the allowlisted aggregate task shape and finishes with lease token', async () => {
  const calls = [];
  const queue = {
    ...lifecycleStub,
    getAgentTaskQueueHealth: async () => ({ queued: 1, claimed: 2, in_progress: 3, failed_last_24h: 4, expired_leases: 5, oldest_queued_minutes: 6 }),
    claimSafeCoderTask: async input => {
      calls.push(['claim', input]);
      return { id: '11111111-1111-4111-8111-111111111111', task_key: 'audit_frontend_runtime',
        event_code: 'js_runtime', page_area: 'other', occurrences: 5,
        claim_token: '22222222-2222-4222-8222-222222222222', private_text: 'must not escape' };
    },
    finishSafeCoderTask: async input => { calls.push(['finish', input]); return true; },
  };
  const bridge = createCoderTaskBridge({ queue, token });
  const claimed = await bridge(request({ action: 'claim' }));
  assert.deepEqual(claimed.body, { ok: true, task: {
    id: '11111111-1111-4111-8111-111111111111', task_key: 'audit_frontend_runtime',
    event_code: 'js_runtime', page_area: 'other', occurrences: 5,
    claim_token: '22222222-2222-4222-8222-222222222222',
  } });
  const finished = await bridge(request({ action: 'finish', task_id: '11111111-1111-4111-8111-111111111111',
    claim_token: '22222222-2222-4222-8222-222222222222', result_code: 'model_no_patch' }));
  assert.deepEqual(finished.body, { ok: true, saved: true });
  assert.equal(calls[0][1].workerId, 'fam-agent-qwen-coder-v1');
  assert.equal(calls[1][1].resultCode, 'model_no_patch');
  assert.equal((await bridge(request({ action: 'finish', task_id: '11111111-1111-4111-8111-111111111111',
    claim_token: '22222222-2222-4222-8222-222222222222', result_code: 'model_completed' }))).status, 400);
  assert.equal((await bridge(request({ action: 'claim', extra: true }))).status, 400);
  assert.equal((await bridge(request({ action: 'finish', task_id: 'not-a-uuid',
    claim_token: '22222222-2222-4222-8222-222222222222', result_code: 'model_no_patch' }))).status, 400);
});

test('coder bridge exposes only bounded aggregate queue health to the authenticated control tower', async () => {
  let reads = 0;
  const health = { queued: 4, claimed: 1, in_progress: 2, failed_last_24h: 3, expired_leases: 0, oldest_queued_minutes: 17 };
  const queue = { ...lifecycleStub, getAgentTaskQueueHealth: async () => { reads++; return { ...health, private_task_text: 'never returned' }; },
    claimSafeCoderTask: async () => null, finishSafeCoderTask: async () => false };
  const bridge = createCoderTaskBridge({ queue, token });
  const result = await bridge(request({ action: 'health' }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, queue: health });
  assert.equal(reads, 1);
  assert.equal((await bridge(request({ action: 'health', extra: true }))).status, 400);
  assert.equal((await bridge(request({ action: 'health' }, { 'x-fam-agent-token': 'invalid' }))).status, 401);

  for (const invalid of [null, { ...health, queued: -1 }, { ...health, failed_last_24h: 10_000_001 }]) {
    const invalidQueue = { ...queue, getAgentTaskQueueHealth: async () => invalid };
    const invalidResult = await createCoderTaskBridge({ queue: invalidQueue, token })(request({ action: 'health' }));
    assert.equal(invalidResult.status, 502);
  }
});

test('coder bridge returns every supported technical event and rejects unknown event codes', async () => {
  const cases = [
    ['js_runtime', 'audit_frontend_runtime'],
    ['unhandled_rejection', 'audit_frontend_runtime'],
    ['listings_load_failed', 'audit_client_resilience'],
    ['notifications_load_failed', 'audit_client_resilience'],
    ['database_request_failed', 'audit_client_resilience'],
    ['auth_backend_failed', 'audit_client_resilience'],
  ];
  for (const [event_code, task_key] of cases) {
    const queue = { ...lifecycleStub, getAgentTaskQueueHealth: async () => ({ queued: 0, claimed: 0, in_progress: 0, failed_last_24h: 0, expired_leases: 0, oldest_queued_minutes: 0 }), claimSafeCoderTask: async () => ({
      id: '11111111-1111-4111-8111-111111111111', claim_token: '22222222-2222-4222-8222-222222222222',
      task_key, event_code, page_area: 'other', occurrences: 3,
    }), finishSafeCoderTask: async () => true };
    const result = await createCoderTaskBridge({ queue, token })(request({ action: 'claim' }));
    assert.equal(result.status, 200, event_code);
    assert.equal(result.body.task.event_code, event_code);
    assert.equal(result.body.task.task_key, task_key);
  }
  const invalidQueue = { ...lifecycleStub, getAgentTaskQueueHealth: async () => ({ queued: 0, claimed: 0, in_progress: 0, failed_last_24h: 0, expired_leases: 0, oldest_queued_minutes: 0 }), claimSafeCoderTask: async () => ({
    id: '11111111-1111-4111-8111-111111111111', claim_token: '22222222-2222-4222-8222-222222222222',
    task_key: 'audit_client_resilience', event_code: 'unlisted_event', page_area: 'other', occurrences: 3,
  }), finishSafeCoderTask: async () => true };
  assert.equal((await createCoderTaskBridge({ queue: invalidQueue, token })(request({ action: 'claim' }))).status, 502);
});

test('coder bridge exposes bounded lease lifecycle actions only for the active claim token', async () => {
  const calls = [];
  const id = '11111111-1111-4111-8111-111111111111';
  const claimToken = '22222222-2222-4222-8222-222222222222';
  const queue = { ...lifecycleStub, getAgentTaskQueueHealth: async () => ({ queued: 0, claimed: 0, in_progress: 0, failed_last_24h: 0, expired_leases: 0, oldest_queued_minutes: 0 }),
    claimSafeCoderTask: async () => null, finishSafeCoderTask: async () => false,
    startSafeCoderTask: async input => { calls.push(['start', input]); return true; },
    heartbeatSafeCoderTask: async input => { calls.push(['heartbeat', input]); return true; },
    advanceSafeCoderTask: async input => { calls.push(['advance', input]); return true; } };
  const bridge = createCoderTaskBridge({ queue, token });
  const base = { task_id: id, claim_token: claimToken };
  assert.deepEqual((await bridge(request({ action: 'start', ...base }))).body, { ok: true, started: true });
  assert.deepEqual((await bridge(request({ action: 'heartbeat', ...base }))).body, { ok: true, renewed: true });
  assert.deepEqual((await bridge(request({ action: 'advance', ...base, stage: 'qa_passed' }))).body,
    { ok: true, advanced: true });
  assert.equal((await bridge(request({ action: 'advance', ...base, stage: 'pr_created' }))).status, 400);
  assert.deepEqual((await bridge(request({ action: 'advance', ...base, stage: 'pr_created', pr_number: 42 }))).body,
    { ok: true, advanced: true });
  assert.deepEqual(calls.map(([action]) => action), ['start', 'heartbeat', 'advance', 'advance']);
  assert.ok(calls.every(([, input]) => input.workerId === 'fam-agent-qwen-coder-v1' && input.claimToken === claimToken));
  assert.equal(calls[2][1].prNumber, undefined);
  assert.equal(calls[3][1].prNumber, 42);
  assert.equal((await bridge(request({ action: 'start', ...base, extra: true }))).status, 400);
  assert.equal((await bridge(request({ action: 'advance', ...base, stage: 'model_generated', pr_number: 42 }))).status, 400);
});
