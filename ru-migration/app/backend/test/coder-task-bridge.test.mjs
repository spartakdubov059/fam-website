import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoderTaskBridge } from '../services/coder-task-bridge.mjs';

const token = 'local-worker-token-that-is-at-least-32-bytes-long';
function request(body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return { method: 'POST', headers: { 'content-length': String(bytes.length), 'x-fam-agent-token': token, ...headers },
    async *[Symbol.asyncIterator]() { yield bytes; } };
}

test('coder bridge is closed without a strong worker token and rejects browser origins', async () => {
  const queue = { claimSafeCoderTask: async () => null, finishSafeCoderTask: async () => false };
  assert.equal((await createCoderTaskBridge({ queue, token: 'short' })(request({ action: 'claim' }))).status, 503);
  const bridge = createCoderTaskBridge({ queue, token });
  assert.equal((await bridge(request({ action: 'claim' }, { origin: 'https://example.test' }))).status, 403);
  assert.equal((await bridge(request({ action: 'claim' }, { 'x-fam-agent-token': 'wrong-token' }))).status, 401);
  assert.equal((await bridge({ ...request({ action: 'claim' }), method: 'GET' })).status, 405);
});

test('coder bridge returns only the allowlisted aggregate task shape and finishes with lease token', async () => {
  const calls = [];
  const queue = {
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
    claim_token: '22222222-2222-4222-8222-222222222222', result_code: 'model_completed' }));
  assert.deepEqual(finished.body, { ok: true, saved: true });
  assert.equal(calls[0][1].workerId, 'fam-agent-qwen-coder-v1');
  assert.equal(calls[1][1].resultCode, 'model_completed');
  assert.equal((await bridge(request({ action: 'claim', extra: true }))).status, 400);
  assert.equal((await bridge(request({ action: 'finish', task_id: 'not-a-uuid',
    claim_token: '22222222-2222-4222-8222-222222222222', result_code: 'model_completed' }))).status, 400);
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
    const queue = { claimSafeCoderTask: async () => ({
      id: '11111111-1111-4111-8111-111111111111', claim_token: '22222222-2222-4222-8222-222222222222',
      task_key, event_code, page_area: 'other', occurrences: 3,
    }), finishSafeCoderTask: async () => true };
    const result = await createCoderTaskBridge({ queue, token })(request({ action: 'claim' }));
    assert.equal(result.status, 200, event_code);
    assert.equal(result.body.task.event_code, event_code);
    assert.equal(result.body.task.task_key, task_key);
  }
  const invalidQueue = { claimSafeCoderTask: async () => ({
    id: '11111111-1111-4111-8111-111111111111', claim_token: '22222222-2222-4222-8222-222222222222',
    task_key: 'audit_client_resilience', event_code: 'unlisted_event', page_area: 'other', occurrences: 3,
  }), finishSafeCoderTask: async () => true };
  assert.equal((await createCoderTaskBridge({ queue: invalidQueue, token })(request({ action: 'claim' }))).status, 502);
});
