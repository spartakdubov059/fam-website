import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSuspensionWriteGuard } from '../auth/suspension-write-guard.mjs';
import { createMediaApi } from '../services/media-api.mjs';

const actor = { id: 'student-1', school_id: 'school-1', role: 'student' };

test('active suspension blocks every authenticated write but allows reads and returns bounded reason', async () => {
  const checked = [];
  const guard = createSuspensionWriteGuard({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async (...args) => {
      checked.push(args); return { reason: 'synthetic reason'.repeat(40), expires_at: '2099-01-01T00:00:00Z' };
    } },
  });
  let calls = 0;
  const handler = async () => { calls++; return { status: 201, body: { ok: true } }; };
  const blocked = await guard(handler)({ method: 'POST' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'account_suspended');
  assert.ok(blocked.body.message.length < 400);
  assert.deepEqual(checked, [['school-1', 'student-1']]);
  assert.equal((await guard(handler)({ method: 'PATCH' })).status, 403);
  assert.deepEqual(await guard(handler)({ method: 'GET' }), { status: 201, body: { ok: true } });
  assert.equal(calls, 1);
});

test('unavailable suspension state fails closed for an authenticated write', async () => {
  const guard = createSuspensionWriteGuard({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => { throw new Error('synthetic db failure'); } },
  });
  const result = await guard(async () => ({ status: 201 }))({ method: 'POST' });
  assert.deepEqual(result, { status: 503, body: { ok: false, error: 'account_status_unavailable' } });
});

test('missing identity leaves authentication response to the underlying route', async () => {
  let called = false;
  const guard = createSuspensionWriteGuard({
    authenticate: async () => null,
    resolveActor: async () => actor,
    repository: {},
  });
  const result = await guard(async () => { called = true; return { status: 401 }; })({ method: 'POST' });
  assert.equal(called, true);
  assert.equal(result.status, 401);
});

test('self account deletion remains available to a suspended user', async () => {
  let reached = false;
  const guard = createSuspensionWriteGuard({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => ({ reason: 'synthetic', expires_at: '2099-01-01T00:00:00Z' }) },
  });
  const result = await guard(async () => { reached = true; return { status: 200 }; })({
    method: 'DELETE', url: '/api/v1/me/account',
  });
  assert.equal(reached, true);
  assert.equal(result.status, 200);
});

test('mounted suspension guard blocks media uploads, moderation, and pending-image deletion', async () => {
  let mediaWrites = 0;
  const repository = {
    getActiveAccountSuspension: async (schoolId, userId) => {
      assert.equal(schoolId, 'school-1');
      assert.equal(userId, 'student-1');
      return { reason: 'synthetic restriction', expires_at: '2099-01-01T00:00:00Z' };
    },
    reserveImageUpload: async () => { mediaWrites++; return true; },
    registerPendingImage: async () => { mediaWrites++; },
    moderateListingPhoto: async () => { mediaWrites++; return true; },
    claimPendingImageDeletion: async () => { mediaWrites++; return 'lease'; },
    finishPendingImageCleanup: async () => { mediaWrites++; return true; },
  };
  const mediaApi = createMediaApi({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository,
    pendingImages: {
      put: async () => { mediaWrites++; return { key: 'pending/student-1/image.webp', contentType: 'image/webp', bytes: 1 }; },
      delete: async () => { mediaWrites++; },
    },
  });
  const guarded = createSuspensionWriteGuard({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository,
  })(mediaApi);
  const request = (method, url) => {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = { 'content-type': 'image/png' };
    return req;
  };
  const paths = [
    ['POST', '/api/v1/media/pending'],
    ['POST', '/api/v1/avatars/media/pending'],
    ['PATCH', '/api/v1/listings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/photos/0/moderation'],
    ['DELETE', '/api/v1/media/pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  ];
  for (const [method, url] of paths) {
    const result = await guarded(request(method, url));
    assert.equal(result.status, 403, url);
    assert.equal(result.body.error, 'account_suspended', url);
  }
  assert.equal(mediaWrites, 0);
});
