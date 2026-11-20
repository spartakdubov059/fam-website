import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';

function request() {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = '/api/v1/me/ideas'; req.headers = {};
  return req;
}

test('own idea history requires an authenticated school profile and returns at most 50 rows', async () => {
  let calls = 0;
  const ideas = Array.from({ length: 51 }, (_, index) => ({ id: String(index), text: 'synthetic' }));
  const api = createListingsApi({
    authenticate: async () => ({ issuer: 'synthetic', subject: 'owner' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a' }),
    repository: { listOwnIdeas: async (userId, schoolId) => {
      calls++; assert.equal(userId, '11111111-1111-4111-8111-111111111111'); assert.equal(schoolId, 'school-a'); return ideas;
    } },
  });
  const response = await api(request());
  assert.equal(response.status, 200);
  assert.equal(response.body.ideas.length, 50);
  assert.equal(calls, 1);
});

test('own idea history does not query data for guests or profiles without a school', async () => {
  let reads = 0;
  const guest = createListingsApi({ authenticate: async () => null, resolveActor: async () => null,
    repository: { listOwnIdeas: async () => { reads++; return []; } } });
  assert.equal((await guest(request())).status, 401);
  const noSchool = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    repository: { listOwnIdeas: async () => { reads++; return []; } } });
  assert.equal((await noSchool(request())).status, 403);
  assert.equal(reads, 0);
});
