import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuspensionWriteGuard } from '../auth/suspension-write-guard.mjs';

const actor = { id: 'student-1', school_id: 'school-1', role: 'student' };

test('active suspension blocks every authenticated write but allows reads and returns bounded reason', async () => {
  const checked = [];
  const guard = createSuspensionWriteGuard({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async (...args) => {
      checked.push(args); return { reason: 'synthetic reason'.repeat(40), expires_at: '2099-01-01T00:00:00Z' };
    } },
  });
  let calls = 0;
  const handler = async () => { calls++; return { status: 201, body: { ok: true } }; };
  const blocked = await guard(handler)({ method: 'POST' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'account_suspended');
  assert.ok(blocked.body.message.length < 400);
  assert.deepEqual(checked, [['school-1', 'student-1']]);
  assert.equal((await guard(handler)({ method: 'PATCH' })).status, 403);
  assert.deepEqual(await guard(handler)({ method: 'GET' }), { status: 201, body: { ok: true } });
  assert.equal(calls, 1);
});

test('unavailable suspension state fails closed for an authenticated write', async () => {
  const guard = createSuspensionWriteGuard({
    authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => { throw new Error('synthetic db failure'); } },
  });
  const result = await guard(async () => ({ status: 201 }))({ method: 'POST' });
  assert.deepEqual(result, { status: 503, body: { ok: false, error: 'account_status_unavailable' } });
});

test('missing identity leaves authentication response to the underlying route', async () => {
  let called = false;
  const guard = createSuspensionWriteGuard({
    authenticate: async () => null,
    resolveActor: async () => actor,
    repository: {},
  });
  const result = await guard(async () => { called = true; return { status: 401 }; })({ method: 'POST' });
  assert.equal(called, true);
  assert.equal(result.status, 401);
});
