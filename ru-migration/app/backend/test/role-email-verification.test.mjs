import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoleEmailVerification } from '../services/role-email-verification.mjs';

const identity = { issuer: 'https://login.yandex.ru', subject: 'synthetic-subject', email: ' Student@Example.Test ' };
const actor = { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' };

test('role email verification sends a short lived code without persisting email or code', async () => {
  let reserved; let sent; let verified = false;
  const repository = {
    startRoleEmailVerification: async value => { reserved = value; return { ok: true, already_verified: false }; },
    clearRoleEmailChallenge: async () => true,
    verifyRoleEmailVerification: async value => { verified = value.codeDigest === reserved.codeDigest; return { ok: verified, verified }; },
    isRoleEmailVerified: async value => verified && value.emailDigest === reserved.emailDigest,
  };
  const service = createRoleEmailVerification({ repository, verificationKey: 'synthetic email verification key at least 32 bytes',
    sendEmail: async value => { sent = value; }, now: () => 1_800_000_000_000, createCode: () => '123456' });
  assert.equal(service.available, true);
  assert.deepEqual(await service.start(identity, actor, 'synthetic-function-iam-token-0123456789'), { ok: true, sent: true });
  assert.equal(sent.to, 'student@example.test');
  assert.equal(sent.code, '123456');
  assert.equal(sent.accessToken, 'synthetic-function-iam-token-0123456789');
  assert.equal(JSON.stringify(reserved).includes('student@example.test'), false);
  assert.equal(JSON.stringify(reserved).includes('123456'), false);
  assert.deepEqual(await service.verify(identity, actor, '123456'), { ok: true, verified: true });
  assert.equal(await service.isVerified(identity), true);
});

test('email verification fails closed without a provider email, sender, or function IAM token', async () => {
  const unavailable = createRoleEmailVerification({ repository: {}, verificationKey: 'synthetic email verification key at least 32 bytes' });
  assert.equal(unavailable.available, false);
  assert.deepEqual(await unavailable.start(identity, actor, 'synthetic-token'), { ok: false, code: 'email_verification_unavailable' });
  const service = createRoleEmailVerification({ repository: {
    startRoleEmailVerification: async () => { throw new Error('must not reserve'); },
    isRoleEmailVerified: async () => false,
    verifyRoleEmailVerification: async () => ({ ok: false }),
  }, verificationKey: 'synthetic email verification key at least 32 bytes', sendEmail: async () => {} });
  assert.deepEqual(await service.start({ ...identity, email: undefined }, actor, 'synthetic-token'), { ok: false, code: 'verified_email_required' });
  assert.deepEqual(await service.start(identity, actor, null), { ok: false, code: 'email_delivery_unavailable' });
});

test('email delivery failure clears the active challenge and never returns code or address', async () => {
  let cleared;
  const service = createRoleEmailVerification({ repository: {
    startRoleEmailVerification: async value => { cleared = { issuer: value.issuer, subject: value.subject, codeDigest: value.codeDigest }; return { ok: true }; },
    clearRoleEmailChallenge: async value => { assert.deepEqual(value, cleared); return true; },
    isRoleEmailVerified: async () => false,
    verifyRoleEmailVerification: async () => ({ ok: false }),
  }, verificationKey: 'synthetic email verification key at least 32 bytes', sendEmail: async () => { throw new Error('synthetic delivery failure'); },
  now: () => 1_800_000_000_000, createCode: () => '654321' });
  const result = await service.start(identity, actor, 'synthetic-function-iam-token-0123456789');
  assert.deepEqual(result, { ok: false, code: 'email_delivery_unavailable' });
  assert.equal(JSON.stringify(result).includes('654321'), false);
  assert.equal(JSON.stringify(result).includes('student@example.test'), false);
});
