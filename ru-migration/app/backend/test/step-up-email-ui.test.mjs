import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWithEmailStepUp } from '../../web/step-up-email.js';

const json = (value, ok = true, status = ok ? 200 : 403) => ({ ok, status, json: async () => value });

test('email step-up prompts only after a protected action is challenged, verifies once, and retries the same action once', async () => {
  const calls = [];
  const answers = [json({ ok: false, error: 'fresh_authentication_required' }, false), json({ ok: true, sent: true }),
    json({ ok: true }), json({ ok: true, approved: true })];
  const result = await requestWithEmailStepUp({ url: '/api/v1/suspensions/synthetic-id',
    init: { method: 'PATCH', body: '{"action":"issue"}' }, promptImpl: message => {
      assert.match(message, /шестизначный код/); return '123456';
    }, fetchImpl: async (url, init) => { calls.push({ url, init }); return answers.shift(); } });
  assert.equal(result.response.ok, true);
  assert.deepEqual(result.result, { ok: true, approved: true });
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/suspensions/synthetic-id', '/api/v1/me/step-up/email',
    '/api/v1/me/step-up/email', '/api/v1/suspensions/synthetic-id']);
  assert.equal(JSON.parse(calls[1].init.body).action, 'send');
  assert.deepEqual(JSON.parse(calls[2].init.body), { action: 'verify', code: '123456' });
  assert.equal(calls[3].init.body, calls[0].init.body);
});

test('email step-up does not retry after cancellation, failed verification, or a second challenge', async () => {
  let calls = 0;
  const cancelled = await requestWithEmailStepUp({ url: '/sensitive', init: { method: 'DELETE' }, promptImpl: () => null,
    fetchImpl: async url => { calls++; return url === '/sensitive' ? json({ error: 'fresh_authentication_required' }, false) : json({ ok: true }); } });
  assert.equal(cancelled.stepUpError, 'code_entry_cancelled');
  assert.equal(calls, 2);

  calls = 0;
  const rejected = await requestWithEmailStepUp({ url: '/sensitive', init: { method: 'DELETE' }, promptImpl: () => '123456',
    fetchImpl: async url => { calls++; if (url === '/sensitive') return json({ error: 'fresh_authentication_required' }, false);
      return calls === 2 ? json({ ok: true }) : json({ ok: false, error: 'invalid_verification_code' }, false, 400); } });
  assert.equal(rejected.stepUpError, 'invalid_verification_code');
  assert.equal(calls, 3);
});
