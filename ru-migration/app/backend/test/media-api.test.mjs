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
