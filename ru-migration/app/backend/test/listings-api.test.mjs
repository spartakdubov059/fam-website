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
