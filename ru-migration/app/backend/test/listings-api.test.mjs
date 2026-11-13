import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';
function req(body = {}, method = 'POST') {
  const request = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = '/api/v1/listings';
  return request;
}
test('API requires verified identity and database profile before writing', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null, repository: { createListing: async () => { writes++; } } });
  const response = await handler(req({ title: 'x' }));
  assert.equal(response.status, 401); assert.equal(writes, 0);
});
test('API maps identity to database profile and persists unreviewed content as pending', async () => {
  let record;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }), resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: { createListing: async (x) => { record = x; return { id: 'synthetic-listing' }; } } });
  const response = await handler(req({ title: 'Book', description: 'School book', category: 'Учёба', user_id: 'forged' }));
  assert.equal(response.status, 201); assert.equal(record.user_id, 'synthetic-user'); assert.equal(record.status, 'pending');
});
test('public listing read needs no student identity and returns only repository-approved projection', async () => {
  const safeRow = { id: 'synthetic-listing', title: 'Book', status: 'active' };
  const handler = createListingsApi({ authenticate: async () => { throw new Error('public read must not authenticate'); },
    resolveActor: async () => { throw new Error('public read must not resolve a profile'); },
    repository: { listActiveListings: async () => [safeRow] } });
  const request = req({}, 'GET'); request.url = '/api/v1/listings';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, listings: [safeRow] });
});
test('public listing read fails closed when the database is unavailable', async () => {
  const handler = createListingsApi({ repository: { listActiveListings: async () => { throw new Error('offline'); } } });
  const request = req({}, 'GET'); request.url = '/api/v1/listings';
  const response = await handler(request);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'database_unavailable');
});

test('pending moderation queue is restricted to the authenticated school staff profile', async () => {
  let schoolScope;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'verified' }),
    resolveActor: async () => ({ id: 'staff-id', school_id: 'school-a', role: 'school_admin' }),
    repository: { listPendingListings: async schoolId => { schoolScope = schoolId; return [{ id: 'pending-id', photo_status: 'pending' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/listings/moderation';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.equal(schoolScope, 'school-a');
  assert.deepEqual(response.body.listings, [{ id: 'pending-id', photo_status: 'pending' }]);

  let reads = 0;
  const student = createListingsApi({ authenticate: async () => ({ subject: 'verified' }),
    resolveActor: async () => ({ id: 'student-id', school_id: 'school-a', role: 'student' }),
    repository: { listPendingListings: async () => { reads++; return []; } } });
  const denied = req({}, 'GET'); denied.url = '/api/v1/listings/moderation';
  assert.equal((await student(denied)).status, 403);
  assert.equal(reads, 0);
});

test('profile endpoint authenticates and returns the database profile, never token roles', async () => {
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', role: 'admin' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: {} });
  const request = req({}, 'GET'); request.url = '/api/v1/me';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.profile, { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' });
});
test('profile endpoint rejects missing authentication', async () => {
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null, repository: {} });
  const request = req({}, 'GET'); request.url = '/api/v1/me';
  assert.equal((await handler(request)).status, 401);
});

test('favorites are scoped to the authenticated database actor', async () => {
  let listedFor;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', user_id: 'forged-user' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { listFavoriteIds: async (userId) => { listedFor = userId; return ['active-listing']; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/favorites';
  const response = await handler(request);
  assert.equal(listedFor, 'synthetic-user');
  assert.deepEqual(response.body, { ok: true, favorite_ids: ['active-listing'] });
});

test('favorite writes use only the authenticated actor and return 404 for non-active listings', async () => {
  let call;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { setFavorite: async (...args) => { call = args; return args[1] === '11111111-1111-4111-8111-111111111111'; } } });
  const request = req({ user_id: 'forged-user' }, 'PUT'); request.url = '/api/v1/listings/11111111-1111-4111-8111-111111111111/favorite';
  const response = await handler(request);
  assert.deepEqual(call, ['synthetic-user', '11111111-1111-4111-8111-111111111111', true]);
  assert.equal(response.status, 200);
  const missing = req({}, 'PUT'); missing.url = '/api/v1/listings/22222222-2222-4222-8222-222222222222/favorite';
  assert.equal((await handler(missing)).status, 404);
});

test('favorites fail closed when the database adapter is unavailable', async () => {
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: {} });
  const request = req({}, 'GET'); request.url = '/api/v1/favorites';
  assert.equal((await handler(request)).status, 503);
});

test('idea submission is authenticated and bound to the database profile', async () => {
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', user_id: 'forged-user' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { createIdea: async record => { saved = record; return { id: 'synthetic-idea' }; } } });
  const request = req({ text: 'Было бы здорово открыть книжный обмен', user_id: 'forged-user' });
  request.url = '/api/v1/ideas';
  const response = await handler(request);
  assert.equal(response.status, 201);
  assert.equal(saved.user_id, 'synthetic-user');
  assert.equal(saved.school_id, 'synthetic-school');
  assert.equal(saved.admin_status, 'new');
});

test('message API fails closed when moderation is unavailable', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', role: 'student' }),
    repository: { createMessage: async () => { writes++; return { id: 'unexpected' }; } } });
  const request = req({ receiver_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', body: 'Привет' });
  request.url = '/api/v1/messages';
  const response = await handler(request);
  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'pending');
  assert.equal(writes, 0);
});

test('message API uses the verified sender profile after an explicit approval', async () => {
  let saved;
  const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', user_id: 'forged-sender' }),
    resolveActor: async () => ({ id: senderId, school_id: 'school-a', role: 'student' }),
    review: async () => ({ action: 'ok' }),
    repository: { createMessage: async record => { saved = record; return { id: 'synthetic-message' }; } } });
  const request = req({ sender_id: 'forged-sender', receiver_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', body: 'Привет' });
  request.url = '/api/v1/messages';
  const response = await handler(request);
  assert.equal(response.status, 201);
  assert.equal(saved.sender_id, senderId);
  assert.equal(saved.school_id, 'school-a');
});

test('message read requires authentication and scopes data to the database profile', async () => {
  let owner;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { listMessages: async (userId, schoolId) => { owner = [userId, schoolId]; return [{ id: 'owned-message' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/messages';
  const response = await handler(request);
  assert.deepEqual(owner, ['synthetic-user', 'synthetic-school']);
  assert.deepEqual(response.body, { ok: true, messages: [{ id: 'owned-message' }] });
});

test('message read rejects missing identity before querying the database', async () => {
  let reads = 0;
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null,
    repository: { listMessages: async () => { reads++; return []; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/messages';
  assert.equal((await handler(request)).status, 401);
  assert.equal(reads, 0);
});

test('only the authenticated recipient can mark a message read', async () => {
  let args;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { markMessageRead: async (...values) => { args = values; return true; } } });
  const request = req({}, 'PATCH'); request.url = '/api/v1/messages/11111111-1111-4111-8111-111111111111/read';
  const response = await handler(request);
  assert.deepEqual(args, ['synthetic-user', 'synthetic-school', '11111111-1111-4111-8111-111111111111']);
  assert.equal(response.body.is_read, true);
});

test('listing moderation trusts database role and school scope, not token claims or request fields', async () => {
  let call;
  const id = '11111111-1111-4111-8111-111111111111';
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', role: 'school_admin' }),
    resolveActor: async () => ({ id: 'admin-id', school_id: 'school-a', role: 'school_admin' }),
    repository: { moderateListing: async (...args) => { call = args; return true; } } });
  const request = req({ decision: 'approve', school_id: 'school-b', status: 'active' }, 'PATCH');
  request.url = `/api/v1/listings/${id}/moderation`;
  const response = await handler(request);
  assert.deepEqual(call, [id, 'school-a', 'active']);
  assert.deepEqual(response, { status: 200, body: { ok: true, status: 'active' } });
});

test('listing moderation rejects student role and invalid decisions before repository access', async () => {
  let writes = 0;
  const base = { authenticate: async () => ({ subject: 'oidc-sub', role: 'school_admin' }),
    repository: { moderateListing: async () => { writes++; return true; } } };
  const id = '11111111-1111-4111-8111-111111111111';
  const student = createListingsApi({ ...base, resolveActor: async () => ({ id: 'student', school_id: 'school-a', role: 'student' }) });
  const request = req({ decision: 'approve' }, 'PATCH'); request.url = `/api/v1/listings/${id}/moderation`;
  assert.equal((await student(request)).status, 403);
  const admin = createListingsApi({ ...base, resolveActor: async () => ({ id: 'admin', school_id: 'school-a', role: 'school_admin' }) });
  const invalid = req({ decision: 'active' }, 'PATCH'); invalid.url = `/api/v1/listings/${id}/moderation`;
  assert.equal((await admin(invalid)).status, 400);
  assert.equal(writes, 0);
});

test('event registration is bound to the authenticated profile and capacity errors stay explicit', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const registrationRequest = () => {
    const request = Readable.from([]); request.method = 'POST'; request.url = `/api/v1/listings/${eventId}/registrations`; return request;
  };
  let registeredAs;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'untrusted-subject' }),
    resolveActor: async () => ({ id: 'synthetic-registrant', school_id: 'school-a', role: 'student' }),
    repository: { registerForEvent: async (...args) => { registeredAs = args; return { event_id: args[0], user_id: args[1], status: 'confirmed' }; } } });
  const request = registrationRequest();
  const response = await handler(request);
  assert.deepEqual(registeredAs, [eventId, 'synthetic-registrant']);
  assert.deepEqual(response, { status: 201, body: { ok: true, registration: { event_id: eventId, user_id: 'synthetic-registrant', status: 'confirmed' } } });

  const full = createListingsApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: 'u', role: 'student' }),
    repository: { registerForEvent: async () => { throw Object.assign(new Error('full'), { code: 'no_seats_available' }); } } });
  const fullResponse = await full(registrationRequest());
  assert.equal(fullResponse.status, 409);
  assert.equal(fullResponse.body.error, 'no_seats_available');
});

test('event applicant names are visible only to same-school council roles', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let scope;
  const repository = { listEventApplicants: async (...args) => { scope = args; return [{ first_name: 'Тест', class_name: '8А', status: 'pending' }]; } };
  const student = createListingsApi({ authenticate: async () => ({ subject: 's' }),
    resolveActor: async () => ({ id: 'student', role: 'student', school_id: 'school-a' }), repository });
  const studentRequest = req({}, 'GET'); studentRequest.url = `/api/v1/listings/${id}/registrations`;
  assert.equal((await student(studentRequest)).status, 403);
  assert.equal(scope, undefined);
  const council = createListingsApi({ authenticate: async () => ({ subject: 's', school_id: 'forged' }),
    resolveActor: async () => ({ id: 'council', role: 'council_member', school_id: 'school-a' }), repository });
  const councilRequest = req({}, 'GET'); councilRequest.url = `/api/v1/listings/${id}/registrations`;
  const response = await council(councilRequest);
  assert.deepEqual(scope, [id, 'school-a']);
  assert.deepEqual(response.body, { ok: true, applicants: [{ first_name: 'Тест', class_name: '8А', status: 'pending' }] });
});

test('event registration review requires council role and delegates event-owner scoping to the repository', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  let writes = 0;
  const makeHandler = role => createListingsApi({ authenticate: async () => ({ subject: 'x' }),
    resolveActor: async () => ({ id: 'organizer', school_id: 'school-a', role }),
    repository: { moderateEventRegistration: async (...args) => { writes++; assert.deepEqual(args, [eventId, userId, 'organizer', 'school-a', 'confirmed']); return true; } } });
  const request = req({ decision: 'approve' }, 'PATCH'); request.url = `/api/v1/listings/${eventId}/registrations/${userId}`;
  assert.equal((await makeHandler('student')(request)).status, 403);
  assert.equal(writes, 0);
  assert.deepEqual(await makeHandler('council_member')(request), { status: 200, body: { ok: true, status: 'confirmed' } });
});

test('event occupancy is a public count with no registration identity details', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const handler = createListingsApi({ authenticate: async () => { throw new Error('public occupancy must not authenticate'); },
    repository: { getEventOccupancy: async id => { assert.equal(id, eventId); return 3; } } });
  const request = req({}, 'GET'); request.url = `/api/v1/listings/${eventId}/occupancy`;
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, taken: 3 } });
});
