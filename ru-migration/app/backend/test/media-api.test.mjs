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
    repository: { reserveImageUpload: async userId => { assert.equal(userId, '11111111-1111-4111-8111-111111111111'); return true; },
      registerPendingImage: async (userId, key) => { assert.equal(userId, '11111111-1111-4111-8111-111111111111'); assert.match(key, /^pending\//); } },
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
    maxBytes: 5 * 1024 * 1024,
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

test('idea image uploads enforce the smaller 2 MB source limit before storage', async () => {
  let writes = 0;
  let saved;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: '33333333-3333-4333-8333-333333333333' }),
    repository: { reserveImageUpload: async () => true, registerPendingImage: async () => {} },
    pendingImages: { put: async input => { writes++; saved = input; return { key: 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', contentType: 'image/webp', bytes: 12 }; } } });
  const path = '/api/v1/ideas/media/pending';
  assert.equal((await api(request({ path, body: Buffer.alloc(2 * 1024 * 1024 + 1) }))).status, 413);
  assert.equal(writes, 0);
  assert.equal((await api(request({ path }))).status, 201);
  assert.equal(saved.maxBytes, 2 * 1024 * 1024);
  const avatarPath = '/api/v1/avatars/media/pending';
  assert.equal((await api(request({ path: avatarPath, body: Buffer.alloc(2 * 1024 * 1024 + 1) }))).status, 413);
  assert.equal(writes, 1);
  assert.equal((await api(request({ path: avatarPath }))).status, 201);
  assert.equal(saved.maxBytes, 2 * 1024 * 1024);
});

test('pending media upload rejects storage keys that do not belong to the authenticated user', async () => {
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { reserveImageUpload: async () => true, registerPendingImage: async () => true },
    pendingImages: { put: async () => ({ key: 'pending/22222222-2222-4222-8222-222222222222/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', contentType: 'image/webp', bytes: 10 }) } });
  assert.equal((await api(request())).status, 503);
});

test('pending media upload removes the object and returns no key when YDB cannot register it', async () => {
  const removed = [];
  const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { reserveImageUpload: async () => true, registerPendingImage: async () => { throw new Error('db offline'); } },
    pendingImages: { put: async () => ({ key, contentType: 'image/webp', bytes: 10 }), delete: async objectKey => removed.push(objectKey) } });
  const result = await api(request());
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: 'media_unavailable' });
  assert.deepEqual(removed, [key]);
});

test('upload quota is reserved before image decoding and returns 429 when exhausted', async () => {
  let reservations = 0;
  let decodes = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'x' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { reserveImageUpload: async () => { reservations++; return false; },
      registerPendingImage: async () => {} },
    pendingImages: { put: async () => { decodes++; throw new Error('must not decode'); } } });
  assert.deepEqual(await api(request()), { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.equal(reservations, 1);
  assert.equal(decodes, 0);
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

test('suspended same-school moderators cannot read pending listing photos or submit photo decisions', async () => {
  const listing = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' };
  const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'school_admin', school_id: 'school-a' };
  let imageReads = 0;
  let decisions = 0;
  let suspensionChecks = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => actor,
    repository: {
      getListingPhoto: async () => listing,
      getActiveAccountSuspension: async (schoolId, userId) => {
        suspensionChecks++;
        assert.equal(schoolId, actor.school_id); assert.equal(userId, actor.id);
        return { suspension_id: 'synthetic-suspension' };
      },
      moderateListingPhoto: async () => { decisions++; return true; },
    },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('private-image'); } },
  });
  const preview = await api(request({ method: 'GET', path: `/api/v1/listings/${listing.id}/photo` }));
  const decision = await api(request({ method: 'PATCH', path: `/api/v1/listings/${listing.id}/photo`, body: Buffer.from('{"decision":"approve"}'), contentType: 'application/json' }));
  assert.deepEqual(preview, { status: 403, body: { ok: false, error: 'account_suspended' } });
  assert.deepEqual(decision, preview);
  assert.equal(suspensionChecks, 2);
  assert.equal(imageReads, 0);
  assert.equal(decisions, 0);
});

test('pending photo access fails closed when suspension status cannot be verified', async () => {
  const listing = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' };
  let imageReads = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111', role: 'council_member', school_id: 'school-a' }),
    repository: { getListingPhoto: async () => listing, getActiveAccountSuspension: async () => { throw new Error('synthetic database failure'); } },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('private-image'); } },
  });
  const result = await api(request({ method: 'GET', path: `/api/v1/listings/${listing.id}/photo` }));
  assert.deepEqual(result, { status: 503, body: { ok: false, error: 'database_unavailable' } });
  assert.equal(imageReads, 0);
});

test('private image reads distinguish database outages from missing images', async () => {
  const ideaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const listingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'student', school_id: 'school-a' };
  const pendingImages = { get: async () => { throw new Error('storage should not be reached'); } };
  const unavailable = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => actor,
    repository: {
      getSchoolIdeaImage: async () => { throw new Error('synthetic database outage'); },
      getListingPhoto: async () => { throw new Error('synthetic database outage'); },
    }, pendingImages });
  assert.deepEqual(await unavailable(request({ method: 'GET', path: `/api/v1/ideas/${ideaId}/images/0` })),
    { status: 503, body: { ok: false, error: 'database_unavailable' } });
  assert.deepEqual(await unavailable(request({ method: 'GET', path: `/api/v1/listings/${listingId}/photo` })),
    { status: 503, body: { ok: false, error: 'database_unavailable' } });

  const missing = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => actor,
    repository: { getSchoolIdeaImage: async () => null, getListingPhoto: async () => null }, pendingImages });
  assert.deepEqual(await missing(request({ method: 'GET', path: `/api/v1/ideas/${ideaId}/images/0` })),
    { status: 404, body: { ok: false, error: 'idea_image_unavailable' } });
  assert.deepEqual(await missing(request({ method: 'GET', path: `/api/v1/listings/${listingId}/photo` })),
    { status: 404, body: { ok: false, error: 'photo_unavailable' } });
});

test('suspended school moderators cannot read pending avatar or idea images by direct URL', async () => {
  const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'school_admin', school_id: 'school-a' };
  const ideaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const avatarId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let imageReads = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => actor,
    repository: {
      getSchoolIdeaImage: async () => ({ user_id: '22222222-2222-4222-8222-222222222222', school_id: actor.school_id, image_key: 'pending/22222222-2222-4222-8222-222222222222/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp', image_status: 'pending' }),
      getAvatarReview: async () => ({ id: avatarId, user_id: '22222222-2222-4222-8222-222222222222', school_id: actor.school_id, image_key: 'pending/22222222-2222-4222-8222-222222222222/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp', status: 'pending' }),
      getActiveAccountSuspension: async (schoolId, userId) => {
        assert.equal(schoolId, actor.school_id); assert.equal(userId, actor.id);
        return { suspension_id: 'synthetic-suspension' };
      },
    },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('private-image'); } },
  });
  const idea = await api(request({ method: 'GET', path: `/api/v1/ideas/${ideaId}/images/0` }));
  const avatar = await api(request({ method: 'GET', path: `/api/v1/avatars/${avatarId}/photo` }));
  assert.deepEqual(idea, { status: 403, body: { ok: false, error: 'account_suspended' } });
  assert.deepEqual(avatar, idea);
  assert.equal(imageReads, 0);
});

test('a suspended school-role owner retains access to their own idea attachment', async () => {
  const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'school_admin', school_id: 'school-a' };
  let imageReads = 0;
  let suspensionChecks = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => actor,
    repository: {
      getSchoolIdeaImage: async () => ({ user_id: actor.id, school_id: actor.school_id, image_key: `pending/${actor.id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`, image_status: 'pending' }),
      getActiveAccountSuspension: async () => { suspensionChecks++; return { suspension_id: 'synthetic-suspension' }; },
    },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('private-image'); } },
  });
  const result = await api(request({ method: 'GET', path: '/api/v1/ideas/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/images/0' }));
  assert.equal(result.status, 200);
  assert.equal(imageReads, 1);
  assert.equal(suspensionChecks, 0);
});

test('approved active listing photos are visible only to members of their school', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const listing = { school_id: 'school-a', status: 'active', image_key: 'pending/key.webp', photo_status: 'approved' };
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ school_id: 'school-a', role: 'student' }),
    repository: { getListingPhoto: async () => listing }, pendingImages: { get: async () => Buffer.from('webp') } });
  const publicPhoto = await api(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }));
  assert.equal(publicPhoto.status, 200);
  assert.equal(publicPhoto.headers['content-type'], 'image/webp');
  const guestApi = createMediaApi({ authenticate: async () => null, resolveActor: async () => null,
    repository: { getListingPhoto: async () => listing }, pendingImages: { get: async () => Buffer.from('webp') } });
  assert.equal((await guestApi(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }))).status, 404);
  const otherSchoolApi = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ school_id: 'school-b', role: 'student' }),
    repository: { getListingPhoto: async () => listing }, pendingImages: { get: async () => Buffer.from('webp') } });
  assert.equal((await otherSchoolApi(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }))).status, 404);
  listing.photo_status = 'rejected';
  assert.equal((await api(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }))).status, 404);
});

test('listing author can read their approved photo before the listing is public', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const listing = { user_id: ownerId, school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'approved' };
  let imageReads = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ id: ownerId, school_id: 'school-a', role: 'student' }),
    repository: { getListingPhoto: async () => listing },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('webp'); } } });
  assert.equal((await api(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }))).status, 200);
  const sameSchoolNonOwner = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ id: '22222222-2222-4222-8222-222222222222', school_id: 'school-a', role: 'student' }),
    repository: { getListingPhoto: async () => listing },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('webp'); } } });
  assert.equal((await sameSchoolNonOwner(request({ method: 'GET', path: `/api/v1/listings/${id}/photo` }))).status, 404);
  assert.equal(imageReads, 1, 'only the owner can read a private listing photo');
});

test('approved photos of unpublished listings remain private to their owners', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const listing = { user_id: ownerId, school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'approved' };
  let imageReads = 0;
  const createApi = actor => createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => actor,
    repository: { getListingPhoto: async () => listing },
    pendingImages: { get: async () => { imageReads++; return Buffer.from('webp'); } } });
  const path = `/api/v1/listings/${id}/photo`;
  const owner = await createApi({ id: ownerId, school_id: 'school-a', role: 'student' })(request({ method: 'GET', path }));
  assert.equal(owner.status, 200);
  for (const role of ['school_admin', 'council_member', 'student']) {
    const nonOwner = await createApi({ id: '22222222-2222-4222-8222-222222222222', school_id: 'school-a', role })(request({ method: 'GET', path }));
    assert.equal(nonOwner.status, 404, `${role} cannot read a photo before its listing is active`);
  }
  listing.status = 'active';
  const schoolMember = await createApi({ id: '33333333-3333-4333-8333-333333333333', school_id: 'school-a', role: 'student' })(request({ method: 'GET', path }));
  assert.equal(schoolMember.status, 200, 'same-school members can read the photo after publication');
  assert.equal(imageReads, 2, 'only owner and active same-school request reach private storage');
});

test('photo approval requires a moderator from the owning school', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let updates = 0;
  const api = createMediaApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ role: 'school_admin', school_id: 'school-b' }),
    repository: { getActiveAccountSuspension: async () => null,
      getListingPhoto: async () => ({ school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' }),
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

test('idea images are private, and council members can read only AI-approved school ideas', async () => {
  let actor = { id: '33333333-3333-4333-8333-333333333333', school_id: 'school-a', role: 'school_admin' };
  let ideaAiStatus = 'pending';
  let imageReads = 0;
  const imageKey = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  const api = createMediaApi({ authenticate: async () => ({ subject: 'verified' }), resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null,
      getSchoolIdeaImage: async () => ({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a', image_key: imageKey, image_status: 'pending', ai_status: ideaAiStatus }) },
    pendingImages: { get: async key => { imageReads++; assert.equal(key, imageKey); return Buffer.from('synthetic-webp'); } } });
  const req = request({ method: 'GET', path: '/api/v1/ideas/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/images/0', body: Buffer.alloc(0) });
  const result = await api(req);
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(result.headers['content-type'], 'image/webp');
  actor = { ...actor, role: 'council_member' };
  assert.equal((await api(req)).status, 404, 'council cannot fetch pending idea images by direct URL');
  assert.equal(imageReads, 1, 'blocked requests do not read object storage');
  ideaAiStatus = 'approved';
  assert.equal((await api(req)).status, 200, 'council can read an AI-approved idea image while it awaits image review');
  assert.equal(imageReads, 2);
  actor = { ...actor, role: 'school_admin' };
  ideaAiStatus = 'pending';
  actor = { ...actor, school_id: 'school-b' };
  assert.equal((await api(req)).status, 404);
  actor = { id: '11111111-1111-4111-8111-111111111111', role: 'student', school_id: 'other-school' };
  assert.equal((await api(req)).status, 200, 'the image owner can read their own school idea attachment');
  actor = { ...actor, id: '44444444-4444-4444-8444-444444444444', school_id: 'school-a' };
  assert.equal((await api(req)).status, 404, 'other students cannot read schoolmates’ attachments');
});
