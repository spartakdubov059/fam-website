import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';
function req(body = {}, method = 'POST') {
  const request = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
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
  const response = await handler(req({}, 'GET'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, listings: [safeRow] });
});
test('public listing read fails closed when the database is unavailable', async () => {
  const handler = createListingsApi({ repository: { listActiveListings: async () => { throw new Error('offline'); } } });
  const response = await handler(req({}, 'GET'));
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
