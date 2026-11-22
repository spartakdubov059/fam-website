import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';
import { createMediaApi } from '../services/media-api.mjs';

const student = { id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a', role: 'student' };
const moderator = { id: '22222222-2222-4222-8222-222222222222', school_id: 'school-a', role: 'school_admin' };
const key = `pending/${student.id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
function request(method, path, body = '') {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method; req.url = path; req.headers = {};
  return req;
}

test('avatar request accepts only an owned private upload and puts it in school review', async () => {
  let queued;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => student,
    repository: { createAvatarReview: async value => { queued = value; return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; } },
    pendingImages: { get: async () => Buffer.from('synthetic-webp') } });
  const response = await handler(request('POST', '/api/v1/me/avatar', JSON.stringify({ image_key: key })));
  assert.equal(response.status, 202);
  assert.deepEqual(queued, { userId: student.id, schoolId: student.school_id, imageKey: key });
  assert.equal((await handler(request('POST', '/api/v1/me/avatar', JSON.stringify({ image_key: `pending/${moderator.id}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp` })))).status, 400);
  let oversizedQueued = false;
  const oversized = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => student,
    repository: { createAvatarReview: async () => { oversizedQueued = true; return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; } },
    pendingImages: { get: async () => Buffer.alloc(2 * 1024 * 1024 + 1) } });
  assert.equal((await oversized(request('POST', '/api/v1/me/avatar', JSON.stringify({ image_key: key })))).status, 413);
  assert.equal(oversizedQueued, false);
});

test('avatar request shares the hourly listing quota and rejects exhausted quota', async () => {
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => student,
    repository: { createAvatarReview: async () => ({ ok: false, code: 'rate_limited' }) },
    pendingImages: { get: async () => Buffer.from('synthetic-webp') } });
  const response = await handler(request('POST', '/api/v1/me/avatar', JSON.stringify({ image_key: key })));
  assert.deepEqual(response, { status: 429, body: { ok: false, error: 'rate_limited' } });
});

test('avatar moderation list and decisions require same-school school staff', async () => {
  let listedSchool; let decisionArgs;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }), resolveActor: async () => moderator,
    repository: { getActiveAccountSuspension: async () => null, listPendingAvatarReviews: async schoolId => { listedSchool = schoolId; return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]; },
      moderateAvatarReview: async (...args) => { decisionArgs = args; return true; } } });
  const list = await handler(request('GET', '/api/v1/avatars/moderation'));
  assert.equal(list.status, 200); assert.equal(listedSchool, 'school-a');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const review = await handler(request('PATCH', `/api/v1/avatars/${id}/moderation`, '{"decision":"approve"}'));
  assert.equal(review.status, 200);
  assert.deepEqual(decisionArgs, [id, 'school-a', moderator.id, 'approved']);
  const studentHandler = createListingsApi({ authenticate: async () => ({ subject: 'student' }), resolveActor: async () => student, repository: {} });
  assert.equal((await studentHandler(request('GET', '/api/v1/avatars/moderation'))).status, 403);
});

test('avatar bytes stay private and approved photos are readable only by their active profile owner', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const review = { id, user_id: student.id, school_id: 'school-a', image_key: key, status: 'pending' };
  let reads = 0; let current = true; let signedInAs = 'moderator';
  const handler = createMediaApi({ authenticate: async () => signedInAs === 'guest' ? null : ({ subject: signedInAs }),
    resolveActor: async identity => identity.subject === 'owner' ? student
      : identity.subject === 'same-school' ? moderator
        : identity.subject === 'other-school' ? { ...moderator, school_id: 'school-b' } : moderator,
    repository: { getActiveAccountSuspension: async () => null, getAvatarReview: async () => review, isCurrentAvatar: async () => current },
    pendingImages: { get: async imageKey => { reads++; assert.equal(imageKey, key); return Buffer.from('image'); } } });
  const path = `/api/v1/avatars/${id}/photo`;
  assert.equal((await handler(request('GET', path))).status, 200);
  assert.equal(reads, 1);
  review.status = 'approved';
  assert.equal((await handler(request('GET', path))).status, 404, 'another school member cannot read the profile photo');
  signedInAs = 'other-school';
  assert.equal((await handler(request('GET', path))).status, 404, 'a different school cannot read the profile photo');
  signedInAs = 'guest';
  assert.equal((await handler(request('GET', path))).status, 404, 'guests cannot read an approved profile photo');
  signedInAs = 'owner';
  const ownerImage = await handler(request('GET', path));
  assert.equal(ownerImage.status, 200);
  assert.equal(ownerImage.headers['cache-control'], 'private, no-store');
  assert.equal(reads, 2, 'only the pending moderator and owner reads reach private storage');
  current = false;
  assert.equal((await handler(request('GET', path))).status, 404);
});
