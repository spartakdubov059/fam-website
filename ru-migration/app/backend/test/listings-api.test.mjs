import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';
function res(body) { return { statusCode: 200, body, end() {}, writeHead(status) { this.statusCode = status; }, setHeader() {} }; }
function req(body) { return Readable.from([Buffer.from(JSON.stringify(body))]); }
test('API requires verified identity and database profile before writing', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null, repository: { createListing: async () => { writes++; } } });
  const response = await handler(req({ title: 'x' }), res());
  assert.equal(response.status, 401); assert.equal(writes, 0);
});
test('API maps identity to database profile and persists unreviewed content as pending', async () => {
  let record;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }), resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: { createListing: async (x) => { record = x; return { id: 'synthetic-listing' }; } } });
  const response = await handler(req({ title: 'Book', description: 'School book', category: 'Учёба', user_id: 'forged' }), res());
  assert.equal(response.status, 201); assert.equal(record.user_id, 'synthetic-user'); assert.equal(record.status, 'pending');
});
