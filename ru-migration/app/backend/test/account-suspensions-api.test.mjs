import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';

const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const admin = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', school_id: 'school-a', role: 'school_admin' };
function request(method, url, body = null) {
  const req = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method; req.url = url; req.headers = {};
  return req;
}
function api({ authenticatedAt = Math.floor(Date.now() / 1000), role = 'school_admin', repository = {} } = {}) {
  return createListingsApi({
    authenticate: async () => authenticatedAt === null ? null : ({ issuer: 'https://issuer.test', subject: 'admin', authenticated_at: authenticatedAt }),
    resolveActor: async () => role ? ({ ...admin, role }) : null,
    repository,
  });
}

test('suspension issue and lift require fresh authentication and delegate only school-scoped inputs', async () => {
  const calls = [];
  const handler = api({ repository: {
    issueAccountSuspension: async input => { calls.push(['issue', input]); return { ok: true, suspension: { suspension_id: 'synthetic-id', duration_hours: input.durationHours } }; },
    liftAccountSuspension: async input => { calls.push(['lift', input]); return true; },
  } });
  const issued = await handler(request('PATCH', `/api/v1/suspensions/${targetId}`, {
    action: 'issue', duration_hours: 72, reason: 'Repeatedly disrupted the shared school board.',
  }));
  assert.equal(issued.status, 201);
  assert.deepEqual(calls[0], ['issue', { schoolId: 'school-a', targetId, actorId: admin.id, durationHours: 72, reason: 'Repeatedly disrupted the shared school board.' }]);
  const lifted = await handler(request('PATCH', `/api/v1/suspensions/${targetId}`, { action: 'lift' }));
  assert.deepEqual(lifted, { status: 200, body: { ok: true, status: 'lifted' } });
  assert.deepEqual(calls[1], ['lift', { schoolId: 'school-a', targetId, actorId: admin.id }]);
});

test('stale authentication, other roles, self action, invalid duration and contact details are rejected', async () => {
  let mutations = 0;
  const repository = { issueAccountSuspension: async () => { mutations++; return { ok: true }; } };
  const old = api({ authenticatedAt: Math.floor(Date.now() / 1000) - 601, repository });
  assert.equal((await old(request('PATCH', `/api/v1/suspensions/${targetId}`, { action: 'issue', duration_hours: 24, reason: 'Repeatedly disrupted the school group.' }))).body.error, 'fresh_auth_required');
  const student = api({ role: 'student', repository });
  assert.equal((await student(request('PATCH', `/api/v1/suspensions/${targetId}`, { action: 'issue', duration_hours: 24, reason: 'Repeatedly disrupted the school group.' }))).status, 403);
  const fresh = api({ repository });
  assert.equal((await fresh(request('PATCH', `/api/v1/suspensions/${admin.id}`, { action: 'issue', duration_hours: 24, reason: 'Repeatedly disrupted the school group.' }))).body.error, 'cannot_suspend_self');
  assert.equal((await fresh(request('PATCH', `/api/v1/suspensions/${targetId}`, { action: 'issue', duration_hours: 48, reason: 'Repeatedly disrupted the school group.' }))).body.error, 'invalid_duration');
  assert.equal((await fresh(request('PATCH', `/api/v1/suspensions/${targetId}`, { action: 'issue', duration_hours: 24, reason: 'Reach me at 555 123 45678 for details.' }))).body.error, 'invalid_reason');
  assert.equal(mutations, 0);
});

test('school suspension target list is administrator-only and bounded by repository school scope', async () => {
  let lookup;
  const handler = api({ repository: { listSuspensionTargets: async (...args) => { lookup = args; return [{ id: targetId, role: 'student' }]; } } });
  const response = await handler(request('GET', '/api/v1/suspensions/targets'));
  assert.equal(response.status, 200);
  assert.deepEqual(lookup, ['school-a', admin.id]);
  const denied = await api({ role: 'council_member', repository: { listSuspensionTargets: async () => [] } })(request('GET', '/api/v1/suspensions/targets'));
  assert.equal(denied.status, 403);
});
