import test from 'node:test';
import assert from 'node:assert/strict';
import { createListingsApi } from '../services/listings-api.mjs';
import { createStepUpCookie } from '../auth/step-up-cookie.mjs';

const identity = { issuer: 'https://login.yandex.ru', subject: 'synthetic-user', email: 'test@example.test' };
const key = 'test-key-that-is-longer-than-thirty-two-bytes';
function request(body) {
  const data = Buffer.from(JSON.stringify(body));
  return { method: 'POST', url: '/api/v1/me/step-up/email', headers: {}, async *[Symbol.asyncIterator]() { yield data; } };
}

test('step-up email endpoint sends to the authenticated address and issues a short-lived HttpOnly cookie', async () => {
  let sendInput;
  const repo = { startStepUpEmailChallenge: async () => ({ ok: true }), clearStepUpEmailChallenge: async () => true,
    verifyStepUpEmailChallenge: async value => ({ ok: true, confirmed_at: value.currentSeconds, issued_seconds: value.currentSeconds - 30 }) };
  const cookie = createStepUpCookie({ secret: key, secure: false, now: () => 1_900_000_000_000 });
  const api = createListingsApi({ authenticate: async () => identity, resolveActor: async () => null, repository: repo,
    verificationKey: key, sendStepUpEmail: async value => { sendInput = value; }, stepUpCookie: cookie,
    now: () => 1_900_000_000_000 });
  const sent = await api(request({ action: 'send' }), { token: { access_token: 'synthetic-access-token-long-enough' } });
  assert.deepEqual(sent.body, { ok: true, sent: true });
  assert.equal(sendInput.to, identity.email);
  const verified = await api(request({ action: 'verify', code: '123456' }));
  assert.equal(verified.status, 200);
  assert.match(verified.headers['set-cookie'], /HttpOnly/);
  const cookieValue = verified.headers['set-cookie'].split(';')[0];
  const readCookie = createStepUpCookie({ secret: key, secure: false, now: () => 1_900_000_000_000 });
  assert.equal(readCookie.read({ headers: { cookie: cookieValue } }, identity), 1_900_000_000);
  assert.equal(readCookie.read({ headers: { cookie: cookieValue } }, { ...identity, subject: 'other' }), null);
});

test('step-up email endpoint fails closed for anonymous and unconfigured sessions', async () => {
  const anonymous = createListingsApi({ authenticate: async () => null, resolveActor: async () => null, repository: {} });
  assert.equal((await anonymous(request({ action: 'send' }))).status, 401);
  const unavailable = createListingsApi({ authenticate: async () => identity, resolveActor: async () => null, repository: {} });
  assert.equal((await unavailable(request({ action: 'send' }))).status, 503);
});
