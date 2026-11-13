import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMediaApi } from '../services/media-api.mjs';

function request({ method = 'POST', path = '/api/v1/media/pending', body = Buffer.from('synthetic-image-bytes'), contentType = 'image/png', contentLength } = {}) {
  const req = Readable.from(body.length ? [body] : []);
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': contentType, ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) }) };
  return req;
}

test('pending media upload requires an authenticated database profile and binds storage ownership to it', async () => {
  let saved;
  const api = createMediaApi({
    authenticate: async () => ({ subject: 'verified-subject' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111', role: 'student' }),
    repository: { registerPendingImage: async (userId, key) => { assert.equal(userId, '11111111-1111-4111-8111-111111111111'); assert.match(key, /^pending\//); } },
    pendingImages: { put: async input => { saved = input; return { key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', contentType: 'image/webp', bytes: 42 }; } },
  });
  const req = request();
  req.headers['content-type'] = 'image/png; charset=binary';
  const result = await api(req);
  assert.equal(result.status, 201);
  assert.deepEqual(saved, {
    userId: '11111111-1111-4111-8111-111111111111',
    bytes: Buffer.from('synthetic-image-bytes'),
    contentType: 'image/png',
  });
  assert.deepEqual(result.body, { ok: true, image: { key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', content_type: 'image/webp', bytes: 42 } });
});

test('pending media upload rejects guests, missing profiles, and unsupported content types', async () => {
  let writes = 0;
  const base = { pendingImages: { put: async () => { writes++; return { key: 'x', contentType: 'image/webp', bytes: 1 }; } } };
  const guest = createMediaApi({ ...base, authenticate: async () => null, resolveActor: async () => null });
  assert.equal((await guest(request())).status, 401);
  const unprofiled = createMediaApi({ ...base, authenticate: async () => ({ subject: 'x' }), resolveActor: async () => null });
  assert.equal((await unprofiled(request())).status, 403);
  const invalidProfileId = createMediaApi({ ...base, authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: 'not-a-uuid' }) });
  assert.equal((await invalidProfileId(request())).status, 403);
  const api = createMediaApi({ ...base, authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: '22222222-2222-4222-8222-222222222222' }) });
  assert.equal((await api(request({ contentType: 'image/svg+xml' }))).status, 415);
  assert.equal(writes, 0);
});

test('pending media upload enforces byte limits and fails closed when storage is missing', async () => {
  let writes = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: '33333333-3333-4333-8333-333333333333' }),
    pendingImages: { put: async () => { writes++; return { key: 'x', contentType: 'image/webp', bytes: 1 }; } } });
  assert.equal((await api(request({ body: Buffer.alloc(5 * 1024 * 1024 + 1) }))).status, 413);
  assert.equal((await api(request({ body: Buffer.alloc(0) }))).status, 400);
  assert.equal(writes, 0);
  const unconfigured = createMediaApi({ authenticate: async () => null, resolveActor: async () => null, pendingImages: null });
  assert.equal((await unconfigured(request())).status, 503);
});

test('pending media upload rejects storage keys that do not belong to the authenticated user', async () => {
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    pendingImages: { put: async () => ({ key: 'pending/22222222-2222-4222-8222-222222222222/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', contentType: 'image/webp', bytes: 10 }) } });
  assert.equal((await api(request())).status, 503);
});

test('pending media upload removes the object and returns no key when YDB cannot register it', async () => {
  const removed = [];
  const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { registerPendingImage: async () => { throw new Error('db offline'); } },
    pendingImages: { put: async () => ({ key, contentType: 'image/webp', bytes: 10 }), delete: async objectKey => removed.push(objectKey) } });
  const result = await api(request());
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: 'media_unavailable' });
  assert.deepEqual(removed, [key]);
});

test('pending photo preview is limited to moderators from the listing school', async () => {
  const listing = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' };
  let reads = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ role: 'council_member', school_id: 'school-b' }),
    repository: { getListingPhoto: async () => listing }, pendingImages: { get: async () => { reads++; return Buffer.from('image'); } } });
  assert.equal((await api(request({ method: 'GET', path: `/api/v1/listings/${listing.id}/photo` }))).status, 403);
  assert.equal(reads, 0);
});

test('only approved photos on active listings are public and rejected photos remain unavailable', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const listing = { school_id: 'school-a', status: 'active', image_key: 'pending/key.webp', photo_status: 'approved' };
  const api = createMediaApi({ authenticate: async () => null, resolveActor: async () => null,
    repository: { getListingPhoto: async () => listing }, pendingImages: { get: async () => Buffer.from('webp') } });
  const publicPhoto = await api(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }));
  assert.equal(publicPhoto.status, 200);
  assert.equal(publicPhoto.headers['content-type'], 'image/webp');
  listing.photo_status = 'rejected';
  assert.equal((await api(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }))).status, 404);
});

test('photo approval requires a moderator from the owning school', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let updates = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ role: 'school_admin', school_id: 'school-b' }),
    repository: { getListingPhoto: async () => ({ school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' }),
      moderateListingPhoto: async () => { updates++; return true; } }, pendingImages: null });
  const result = await api(request({ method: 'PATCH', path: `/api/v1/listings/${id}/photo`, body: Buffer.from('{"decision":"approve"}'), contentType: 'application/json' }));
  assert.equal(result.status, 404);
  assert.equal(updates, 0);
});

test('failed listing submissions can delete only the caller own unlinked pending image', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const removed = [];
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => ({ id: userId }),
    repository: { claimPendingImageDeletion: async (user, key) => user === userId && key === `pending/${userId}/${objectId}.webp` ? 'claim' : null,
      finishPendingImageCleanup: async (key, token, deleted) => { assert.equal(token, 'claim'); assert.equal(deleted, true); return true; } },
    pendingImages: { delete: async key => removed.push(key) } });
  const result = await api(request({ method: 'DELETE', path: `/api/v1/media/pending/${objectId}`, body: Buffer.alloc(0) }));
  assert.equal(result.status, 200);
  assert.deepEqual(removed, [`pending/${userId}/${objectId}.webp`]);
});

test('pending image cleanup refuses to delete a photo already attached to a listing', async () => {
  let removed = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { claimPendingImageDeletion: async () => null, finishPendingImageCleanup: async () => true }, pendingImages: { delete: async () => removed++ } });
  const result = await api(request({ method: 'DELETE', path: '/api/v1/media/pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: Buffer.alloc(0) }));
  assert.equal(result.status, 409);
  assert.equal(removed, 0);
});

test('failed pending-image delete releases its database lease for a later retry', async () => {
  const finalized = [];
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { claimPendingImageDeletion: async () => 'claim-1', finishPendingImageCleanup: async (...args) => { finalized.push(args); return true; } },
    pendingImages: { delete: async () => { throw new Error('offline'); } } });
  const result = await api(request({ method: 'DELETE', path: '/api/v1/media/pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: Buffer.alloc(0) }));
  assert.equal(result.status, 503);
  assert.deepEqual(finalized, [[
    'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'claim-1', false,
  ]]);
});
