import test from 'node:test';
import assert from 'node:assert/strict';
import { createStepUpCookie } from '../auth/step-up-cookie.mjs';
import { createStepUpEmailVerification } from '../services/step-up-email-verification.mjs';

const identity = { issuer: 'https://login.yandex.ru', subject: 'synthetic-user', email: 'test@example.test' };
const key = 'test-key-that-is-longer-than-thirty-two-bytes';

test('step-up cookie is short-lived, HttpOnly and bound to identity', () => {
  let now = 1_900_000_000_000;
  const cookie = createStepUpCookie({ secret: key, now: () => now });
  const issued = cookie.issue(identity);
  assert.match(issued.setCookie, /HttpOnly; SameSite=Lax; Secure/);
  const value = issued.setCookie.split(';')[0];
  const req = { headers: { cookie: value } };
  assert.equal(cookie.read(req, identity), now / 1000);
  assert.equal(cookie.read(req, { ...identity, subject: 'other' }), null);
  now += 600_000;
  assert.equal(cookie.read(req, identity), null);
});

test('email step-up stores only digests and requires a bounded delivery and repository', async () => {
  let saved;
  const repo = {
    startStepUpEmailChallenge: async value => { saved = value; return { ok: true }; },
    clearStepUpEmailChallenge: async () => true,
    verifyStepUpEmailChallenge: async value => ({ ok: true, confirmed_at: value.currentSeconds, issued_seconds: value.currentSeconds - 30 }),
  };
  let sent;
  const service = createStepUpEmailVerification({ repository: repo, verificationKey: key,
    sendEmail: async value => { sent = value; }, now: () => 1_900_000_000_000, createCode: () => '123456' });
  assert.equal(service.available, true);
  assert.deepEqual(await service.start(identity, 'synthetic-access-token-long-enough'), { ok: true, sent: true });
  assert.equal(sent.code, '123456');
  assert.equal(saved.codeDigest.includes('123456'), false);
  assert.equal(saved.emailDigest.includes('test@example.test'), false);
  assert.deepEqual(await service.verify(identity, '123456'), { ok: true, confirmed_at: 1_900_000_000, issued_seconds: 1_899_999_970 });
  assert.equal((await service.start(identity, null)).code, 'email_delivery_unavailable');
});

test('email step-up fails closed when sender or repository is unavailable', async () => {
  const service = createStepUpEmailVerification({ verificationKey: key });
  assert.equal(service.available, false);
  assert.equal((await service.start(identity, 'synthetic-access-token-long-enough')).code, 'step_up_unavailable');
});
