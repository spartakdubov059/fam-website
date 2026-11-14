import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAccountDeletionApi } from '../services/account-deletion-api.mjs';

const now = Date.parse('2027-01-01T00:00:00.000Z');
const identity = { issuer: 'https://id.yandex.ru', subject: 'synthetic-subject', authenticated_at: Math.floor(now / 1000) };
const actor = { id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a', role: 'student' };
const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
function request(body = { confirmation: 'УДАЛИТЬ МОЙ АККАУНТ' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'DELETE'; req.url = '/api/v1/me/account'; req.headers = {};
  return req;
}
function reviewRequest(body = { decision: 'approve', confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'PATCH'; req.url = '/api/v1/deletion-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; req.headers = {};
  return req;
}
function api({ authenticated = identity, resolvedActor = actor, repository = {}, pendingImages = {}, clock = now } = {}) {
  return createAccountDeletionApi({
    authenticate: async () => authenticated,
    resolveActor: async () => resolvedActor,
    repository,
    pendingImages,
    now: () => clock,
  });
}

test('account deletion requires fresh Yandex authentication and the exact confirmation phrase', async () => {
  let calls = 0;
  const handler = api({
    authenticated: { ...identity, authenticated_at: Math.floor(now / 1000) - 601 },
    repository: { beginAccountDeletion: async () => { calls++; } },
  });
  assert.equal((await handler(request())).status, 403);
  const noPhrase = await api({ repository: { beginAccountDeletion: async () => { calls++; } } })(request({ confirmation: 'удалить' }));
  assert.equal(noPhrase.status, 400);
  assert.equal(calls, 0);
});

test('account deletion deactivates first, removes every listed object, then clears YDB records', async () => {
  const calls = [];
  const handler = api({
    repository: {
      beginAccountDeletion: async input => { calls.push(['begin', input]); return { ok: true, school_id: actor.school_id }; },
      finishAccountDeletion: async input => { calls.push(['finish', input]); return { ok: true, deleted: true }; },
      restoreAccountAfterDeletionFailure: async input => { calls.push(['restore', input]); return true; },
    },
    pendingImages: {
      listUserObjects: async userId => { calls.push(['list', userId]); return [key]; },
      delete: async imageKey => { calls.push(['delete', imageKey]); },
    },
  });
  const response = await handler(request());
  assert.deepEqual(response, { status: 200, body: { ok: true, deleted: true, removed_images: 1 } });
  assert.deepEqual(calls.map(call => call[0]), ['begin', 'list', 'delete', 'finish']);
  assert.equal(calls[0][1].userId, actor.id);
  assert.equal(calls[3][1].schoolId, actor.school_id);
});

test('last school administrator cannot delete the account', async () => {
  const handler = api({ repository: {
    beginAccountDeletion: async () => ({ ok: false, code: 'last_school_admin' }),
    finishAccountDeletion: async () => ({ ok: false }),
    restoreAccountAfterDeletionFailure: async () => true,
  }, pendingImages: { listUserObjects: async () => [], delete: async () => {} } });
  assert.deepEqual(await handler(request()), { status: 409, body: { ok: false, error: 'last_school_admin' } });
});

test('incomplete object cleanup fails closed and restores the profile', async () => {
  const calls = [];
  const handler = api({ repository: {
    beginAccountDeletion: async () => ({ ok: true, school_id: actor.school_id }),
    finishAccountDeletion: async () => { throw new Error('must not finalize'); },
    restoreAccountAfterDeletionFailure: async input => { calls.push(input); return true; },
  }, pendingImages: { listUserObjects: async () => [key], delete: async () => { throw new Error('storage offline'); } } });
  assert.equal((await handler(request())).status, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, actor.id);
});

test('unexpected keys in the account storage inventory are never deleted', async () => {
  let deleted = false; let restored = false;
  const handler = api({ repository: {
    beginAccountDeletion: async () => ({ ok: true, school_id: actor.school_id }),
    finishAccountDeletion: async () => ({ ok: true }),
    restoreAccountAfterDeletionFailure: async () => { restored = true; },
  }, pendingImages: { listUserObjects: async () => ['pending/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'], delete: async () => { deleted = true; } } });
  assert.equal((await handler(request())).status, 503);
  assert.equal(deleted, false);
  assert.equal(restored, true);
});

test('school administrator approval freshly authenticates, deactivates, cleans storage and finalizes the same-school request', async () => {
  const targetId = '22222222-2222-4222-8222-222222222222';
  const targetKey = `pending/${targetId}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp`;
  const calls = [];
  const handler = api({ resolvedActor: { ...actor, role: 'school_admin', id: '33333333-3333-4333-8333-333333333333' }, repository: {
    beginRequestedAccountDeletion: async input => { calls.push(['begin', input]); return { ok: true, id: targetId, issuer: identity.issuer, subject: 'target-subject', school_id: actor.school_id }; },
    finishAccountDeletion: async input => { calls.push(['finish', input]); return { ok: true, deleted: true }; },
    restoreRequestedAccountDeletion: async input => { calls.push(['restore', input]); return true; },
  }, pendingImages: {
    listUserObjects: async id => { calls.push(['list', id]); return [targetKey]; },
    delete: async imageKey => { calls.push(['delete', imageKey]); },
  } });
  const response = await handler(reviewRequest());
  assert.deepEqual(response, { status: 200, body: { ok: true, deleted: true, removed_images: 1 } });
  assert.deepEqual(calls.map(call => call[0]), ['begin', 'list', 'delete', 'finish']);
  assert.equal(calls[0][1].reviewerId, '33333333-3333-4333-8333-333333333333');
  assert.equal(calls[3][1].preserveRequestId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('request approval rejects stale authentication and restores both request and profile after storage failure', async () => {
  const targetId = '22222222-2222-4222-8222-222222222222';
  const restored = [];
  const admin = { ...actor, role: 'school_admin', id: '33333333-3333-4333-8333-333333333333' };
  const stale = await api({ authenticated: { ...identity, authenticated_at: Math.floor(now / 1000) - 601 }, resolvedActor: admin,
    repository: { beginRequestedAccountDeletion: async () => { throw new Error('must not begin'); } } })(reviewRequest());
  assert.deepEqual(stale, { status: 403, body: { ok: false, error: 'recent_yandex_login_required' } });

  const response = await api({ resolvedActor: admin, repository: {
    beginRequestedAccountDeletion: async () => ({ ok: true, id: targetId, issuer: identity.issuer, subject: 'target-subject', school_id: actor.school_id }),
    finishAccountDeletion: async () => { throw new Error('must not finalize'); },
    restoreRequestedAccountDeletion: async input => { restored.push(input); return true; },
  }, pendingImages: { listUserObjects: async () => { throw new Error('storage offline'); }, delete: async () => {} } })(reviewRequest());
  assert.equal(response.status, 503);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].targetId, targetId);
});
