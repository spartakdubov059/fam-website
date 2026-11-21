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
test('school administrators cannot read global technical alerts', async () => {
  let reads = 0;
  let actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'admin' }),
    resolveActor: async () => actor,
    repository: {
      getActiveAccountSuspension: async () => null,
      listSiteErrorAlerts: async () => { reads++; return [{ event_code: 'database_request_failed', page_area: 'database', event_count: 3, severity: 'critical' }]; },
      getLatestSiteErrorDigest: async () => null,
    } });
  const list = req({}, 'GET'); list.url = '/api/v1/school/admin/technical-alerts';
  assert.equal((await handler(list)).status, 405);
  actor = { id: 'student-a', school_id: 'school-a', role: 'student' };
  assert.equal((await handler(list)).status, 405);
  assert.equal(reads, 0);
});

test('school safety reports are administrator-only and acknowledgement is school-bound', async () => {
  let actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  let selectedSchool; let acknowledged;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'admin' }),
    resolveActor: async () => actor,
    repository: {
      getActiveAccountSuspension: async () => null,
      listSchoolSafetyReports: async schoolId => { selectedSchool = schoolId; return { reports: [{ fingerprint: 'a'.repeat(64) }], period_days: 30 }; },
      acknowledgeSchoolSafetyReport: async input => { acknowledged = input; return input.schoolId === actor.school_id; },
    } });
  const list = req({}, 'GET'); list.url = '/api/v1/school/admin/safety-reports';
  assert.equal((await handler(list)).status, 200);
  assert.equal(selectedSchool, 'school-a');
  actor = { id: 'council-a', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(list)).status, 403);
  actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  const ack = req({ fingerprint: 'a'.repeat(64), category: 'unsafe_image', source_kind: 'image' }, 'PATCH');
  ack.url = '/api/v1/school/admin/safety-reports';
  assert.deepEqual(await handler(ack), { status: 200, body: { ok: true } });
  assert.deepEqual(acknowledged, { schoolId: 'school-a', reviewerId: 'admin-a', fingerprint: 'a'.repeat(64), category: 'unsafe_image', sourceKind: 'image' });
  const malformed = req({ fingerprint: 'bad', category: 'unsafe_image', source_kind: 'image' }, 'PATCH'); malformed.url = ack.url;
  assert.equal((await handler(malformed)).status, 400);
});

test('suspension blocks school safety report access while suspension status remains readable', async () => {
  const actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  let suspended = true; let accessedReports = 0;
  const repository = {
    getActiveAccountSuspension: async () => suspended ? { reason: 'test', expires_at: '2099-01-01T00:00:00Z' } : null,
    listSchoolSafetyReports: async () => { accessedReports++; return { reports: [], period_days: 30 }; },
    acknowledgeSchoolSafetyReport: async () => { accessedReports++; return true; },
  };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'admin' }),
    resolveActor: async () => actor, repository });
  const list = req({}, 'GET'); list.url = '/api/v1/school/admin/safety-reports';
  assert.deepEqual(await handler(list), { status: 403, body: { ok: false, error: 'account_suspended' } });
  const acknowledge = req({ fingerprint: 'a'.repeat(64), category: 'unsafe_image', source_kind: 'image' }, 'PATCH');
  acknowledge.url = list.url;
  assert.deepEqual(await handler(acknowledge), { status: 403, body: { ok: false, error: 'account_suspended' } });
  assert.equal(accessedReports, 0);

  const status = req({}, 'GET'); status.url = '/api/v1/me/suspension';
  assert.deepEqual(await handler(status), { status: 200, body: { ok: true, suspended: true,
    suspension: { reason: 'test', expires_at: '2099-01-01T00:00:00Z' } } });

  suspended = false;
  assert.equal((await handler(list)).status, 200);
  assert.equal(accessedReports, 1);
  repository.getActiveAccountSuspension = async () => { throw new Error('synthetic database failure'); };
  assert.equal((await handler(list)).status, 503, 'suspension check failures deny safety report access');
  assert.equal(accessedReports, 1);
});

test('manual message review queue and decision are limited to the same school administrator', async () => {
  let actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  let selectedSchool; let decision;
  const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'admin' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null,
      listPendingMessages: async schoolId => { selectedSchool = schoolId; return [{ id: messageId, sender_id: 'student-a', body: '<script>текст</script>' }]; },
      decidePendingMessage: async input => { decision = input; return input.schoolId === 'school-a'; },
    } });
  const list = req({}, 'GET'); list.url = '/api/v1/messages/moderation';
  assert.deepEqual((await handler(list)).body.messages, [{ id: messageId, sender_id: 'student-a', body: '<script>текст</script>' }]);
  assert.equal(selectedSchool, 'school-a');
  actor = { id: 'council-a', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(list)).status, 403);
  actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  const patch = req({ decision: 'approve' }, 'PATCH'); patch.url = `/api/v1/messages/moderation/${messageId}`;
  assert.deepEqual(await handler(patch), { status: 200, body: { ok: true } });
  assert.deepEqual(decision, { messageId, schoolId: 'school-a', reviewerId: 'admin-a', decision: 'approve' });
  const invalid = req({ decision: 'publish' }, 'PATCH'); invalid.url = patch.url;
  assert.equal((await handler(invalid)).status, 400);
});

test('school administrator overview is private to the active administrator and bounded to their school', async () => {
  let actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' };
  let selectedSchool;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'admin' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null, getSchoolAdminOverview: async schoolId => { selectedSchool = schoolId; return { users: [{ id: 'synthetic-user' }], listings: [], audit: [], deletion_requests: [], suspensions: [] }; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/school/admin/overview';
  assert.equal((await handler(request)).status, 200);
  assert.equal(selectedSchool, 'school-a');
  actor = { id: 'council-a', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(request)).status, 403);
  actor = { id: 'admin-b', school_id: 'school-b', role: 'school_admin' };
  assert.equal((await handler(request)).status, 200);
  assert.equal(selectedSchool, 'school-b');
});

test('school agent dashboard and idea decisions are school-admin-only and school scoped', async () => {
  let actor = { id: 'admin-a', school_id: 'school-a', role: 'school_admin' }; let saved; let reviewed;
  const ideaId = 'a'.repeat(64);
  const ideaSchoolId = 'school-a';
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'user' }), resolveActor: async () => actor,
    repository: {
      getActiveAccountSuspension: async () => null,
      getSchoolAgentDashboard: async schoolId => { saved = schoolId; return { report: null, ideas: [] }; },
      reviewSchoolAgentIdea: async input => { reviewed = input; return input.schoolId === actor.school_id; },
    } });
  const dashboard = req({}, 'GET'); dashboard.url = '/api/v1/school/admin/agent-dashboard';
  assert.equal((await handler(dashboard)).status, 200); assert.equal(saved, 'school-a');
  actor = { id: 'council-a', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(dashboard)).status, 403);
  actor = { id: 'admin-b', school_id: 'school-b', role: 'school_admin' };
  const decision = req({ decision: 'approve' }, 'PATCH'); decision.url = `/api/v1/school/admin/agent-ideas/${ideaId}`;
  assert.equal((await handler(decision)).status, 200);
  assert.deepEqual(reviewed, { id: ideaId, schoolId: 'school-b', reviewerId: 'admin-b', decision: 'approved' });
  const invalid = req({ decision: 'publish' }, 'PATCH'); invalid.url = decision.url;
  assert.equal((await handler(invalid)).status, 400);
});

test('school profile request status is private to the authenticated identity and omits submitted PII', async () => {
  let identity;
  const handler = createListingsApi({ authenticate: async () => identity,
    repository: { getActiveAccountSuspension: async () => null, getSchoolProfileRequest: async (issuer, subject) => ({
      request_id: 'request-id', school_id: 'lyceum_3', status: 'pending', created_at: '2099-01-01T00:00:00Z',
    }) } });
  const request = req({}, 'GET'); request.url = '/api/v1/profile-requests';
  assert.equal((await handler(request)).status, 401);
  identity = { issuer: 'https://issuer.example', subject: 'synthetic-student' };
  const result = await handler(request);
  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'pending');
  assert.deepEqual(Object.keys(result.body.request).sort(), ['created_at', 'request_id', 'school_id', 'status']);
});
test('role requests use a fixed allowlist, active student profile, and school-admin review scope', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let savedRole; let reviewSchool; let reviewAction;
  let actor = { id: 'student-id', school_id: 'school-a', role: 'student', active: true };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'student' }),
    resolveActor: async () => actor,
    repository: {
      getActiveAccountSuspension: async () => null,
      createSchoolRoleRequest: async request => { savedRole = request.requested_role; return { ok: true, status: 'pending', request_id: id }; },
      listPendingSchoolRoleRequests: async school => { reviewSchool = school; return [{ request_id: id, user_id: '11111111-1111-4111-8111-1234567890ab',
        first_name: 'Тест', last_name: 'Ученик', class_name: '8А', requested_role: 'council_member', status: 'pending', review_started_by: null }]; },
      startSchoolRoleRequestReview: async (requestId, school, reviewer) => { reviewAction = [requestId, school, reviewer]; return true; },
      reviewSchoolRoleRequest: async (requestId, school, reviewer, decision, note) => { reviewAction = [requestId, school, reviewer, decision, note]; return true; },
    } });
  const submit = req({ requested_role: 'Администратор', school_id: 'attacker-school', role: 'owner' }); submit.url = '/api/v1/role-requests';
  assert.equal((await handler(submit)).status, 202);
  assert.equal(savedRole, 'school_admin');
  const invalid = req({ requested_role: 'owner' }); invalid.url = '/api/v1/role-requests';
  assert.equal((await handler(invalid)).status, 400);
  actor = { id: 'admin-id', school_id: 'school-a', role: 'school_admin', active: true };
  const queue = req({}, 'GET'); queue.url = '/api/v1/role-requests/review';
  const queued = await handler(queue);
  assert.equal(queued.status, 200); assert.equal(reviewSchool, 'school-a');
  assert.deepEqual(queued.body.requests[0], { request_id: id, account_code: '7890AB', applicant_name: 'Тест Ученик',
    class_name: '8А', requested_role: 'council_member', status: 'pending', created_at: null, review_started_at: null, review_started_by_me: false });
  assert.equal(Object.hasOwn(queued.body.requests[0], 'user_id'), false, 'review queue exposes only a short account code');
  const start = req({ action: 'start_review' }, 'PATCH'); start.url = `/api/v1/role-requests/${id}`;
  assert.equal((await handler(start)).status, 200); assert.deepEqual(reviewAction, [id, 'school-a', 'admin-id']);
  const approve = req({ decision: 'approve', review_note: 'Проверено школой' }, 'PATCH'); approve.url = `/api/v1/role-requests/${id}`;
  assert.equal((await handler(approve)).status, 200); assert.deepEqual(reviewAction, [id, 'school-a', 'admin-id', 'approve', 'Проверено школой']);
});

test('active suspension blocks school role request changes but allows status reads', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let suspended = true; let actor = { id: 'student-id', school_id: 'school-a', role: 'student', active: true };
  let writes = 0; let lookups = 0;
  const repository = {
    getActiveAccountSuspension: async (schoolId, userId) => {
      lookups++;
      assert.equal(schoolId, 'school-a');
      assert.equal(userId, actor.id);
      return suspended ? { expires_at: '2099-01-01T00:00:00Z' } : null;
    },
    createSchoolRoleRequest: async () => { writes++; return { ok: true, status: 'pending', request_id: id }; },
    getSchoolRoleRequest: async () => ({ request_id: id, status: 'pending' }),
    startSchoolRoleRequestReview: async () => { writes++; return true; },
  };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'user' }),
    resolveActor: async () => actor, repository });
  const status = req({}, 'GET'); status.url = '/api/v1/role-requests';
  assert.equal((await handler(status)).status, 200);
  assert.equal(lookups, 0, 'read-only request status remains available during suspension');

  const submit = req({ requested_role: 'Администратор' }); submit.url = '/api/v1/role-requests';
  assert.deepEqual(await handler(submit), { status: 403, body: { ok: false, error: 'account_suspended' } });
  actor = { id: 'admin-id', school_id: 'school-a', role: 'school_admin', active: true };
  const start = req({ action: 'start_review' }, 'PATCH'); start.url = `/api/v1/role-requests/${id}`;
  assert.deepEqual(await handler(start), { status: 403, body: { ok: false, error: 'account_suspended' } });
  assert.equal(writes, 0, 'suspended users cannot create, claim, or review school role requests');

  suspended = false;
  actor = { id: 'student-id', school_id: 'school-a', role: 'student', active: true };
  const allowed = req({ requested_role: 'Администратор' }); allowed.url = '/api/v1/role-requests';
  assert.equal((await handler(allowed)).status, 202);
  assert.equal(writes, 1);
  repository.getActiveAccountSuspension = async () => { throw new Error('synthetic database failure'); };
  const unavailable = req({ requested_role: 'Администратор' }); unavailable.url = '/api/v1/role-requests';
  assert.equal((await handler(unavailable)).status, 503, 'suspension lookup errors fail closed');
  assert.equal(writes, 1);
});

test('role request status includes the current database role for migrated school access UI', async () => {
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'student' }),
    resolveActor: async () => ({ id: 'student-id', role: 'council_member', school_id: 'school-a' }),
    repository: { getActiveAccountSuspension: async () => null, getSchoolRoleRequest: async (issuer, subject) => ({ request_id: 'request-a', status: 'approved', requested_role: 'council_member' }) } });
  const request = req({}, 'GET'); request.url = '/api/v1/role-requests';
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, role: 'council_member',
    request: { request_id: 'request-a', status: 'approved', requested_role: 'council_member' } } });
});

test('role request submission and review fail closed for unprovisioned or non-admin profiles', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'user' }),
    resolveActor: async () => null,
    repository: { getActiveAccountSuspension: async () => null, createSchoolRoleRequest: async () => { writes++; return { ok: true }; }, listPendingSchoolRoleRequests: async () => { writes++; return []; } } });
  const submit = req({ requested_role: 'Участник Ученического совета' }); submit.url = '/api/v1/role-requests';
  assert.equal((await handler(submit)).status, 403);
  const queue = req({}, 'GET'); queue.url = '/api/v1/role-requests/review';
  assert.equal((await handler(queue)).status, 403);
  assert.equal(writes, 0);
});

test('active suspensions are visible only to the authenticated school administrator and remain school-scoped', async () => {
  let requestedSchool; let actor = { id: 'admin-id', school_id: 'school-a', role: 'school_admin' };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'admin' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null, listActiveAccountSuspensions: async schoolId => { requestedSchool = schoolId; return [{ target_id: 'student-a', expires_at: '2099-01-01T00:00:00Z' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/suspensions';
  const response = await handler(request);
  assert.equal(response.status, 200); assert.equal(requestedSchool, 'school-a');
  assert.deepEqual(response.body.suspensions, [{ target_id: 'student-a', expires_at: '2099-01-01T00:00:00Z' }]);
  actor = { id: 'council-id', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(request)).status, 403);
});
test('a user can read only their own active suspension status', async () => {
  let lookedUp;
  const actor = { id: 'synthetic-user', school_id: 'school-a', role: 'student' };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'user' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async (schoolId, userId) => {
      lookedUp = { schoolId, userId };
      return { reason: 'synthetic reason', duration_hours: 24, expires_at: '2099-01-01T00:00:00Z' };
    } } });
  const request = req({}, 'GET'); request.url = '/api/v1/me/suspension';
  const result = await handler(request);
  assert.equal(result.status, 200);
  assert.deepEqual(lookedUp, { schoolId: 'school-a', userId: 'synthetic-user' });
  assert.equal(result.body.suspended, true);
  assert.equal(result.body.suspension.reason, 'synthetic reason');
});
test('council deletion requests are same-school, bounded, and reject personal contact data', async () => {
  const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let actor = { id: 'council-id', school_id: 'school-a', role: 'council_member' };
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'user' }),
    resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null,
      listAccountDeletionTargets: async (school, requester) => [{ id: targetId, role: 'student' }],
      createAccountDeletionRequest: async input => { saved = input; return { ok: true, request_id: 'synthetic-request', already_exists: false }; },
    } });
  const targets = req({}, 'GET'); targets.url = '/api/v1/deletion-requests/targets';
  assert.equal((await handler(targets)).status, 200);
  const submit = req({ target_id: targetId, reason_code: 'spam', reason: 'Repeated unrelated messages in the school group.' });
  submit.url = '/api/v1/deletion-requests';
  assert.equal((await handler(submit)).status, 202);
  assert.deepEqual(saved, { schoolId: 'school-a', requesterId: 'council-id', targetId, reasonCode: 'spam', reason: 'Repeated unrelated messages in the school group.' });
  const pii = req({ target_id: targetId, reason_code: 'spam', reason: 'Repeated messages; contact me at test@example.org' });
  pii.url = '/api/v1/deletion-requests';
  assert.equal((await handler(pii)).status, 400);
  actor = { id: 'student-id', school_id: 'school-a', role: 'student' };
  assert.equal((await handler(submit)).status, 403);
});
test('only the same-school school administrator can read pending account deletion requests', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let actor = { id: 'admin-id', school_id: 'school-a', role: 'school_admin' };
  let selectedSchool;
  let rejected;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'admin' }),
    resolveActor: async () => actor,
    repository: {
      getActiveAccountSuspension: async () => null,
      listPendingAccountDeletionRequests: async school => { selectedSchool = school; return [{ request_id: requestId, reason: 'synthetic' }]; },
      rejectAccountDeletionRequest: async (...args) => { rejected = args; return args[1] === actor.school_id; },
    } });
  const request = req({}, 'GET'); request.url = '/api/v1/deletion-requests/review';
  assert.equal((await handler(request)).status, 200);
  assert.equal(selectedSchool, 'school-a');
  actor = { id: 'other-admin', school_id: 'school-b', role: 'school_admin' };
  assert.equal((await handler(request)).status, 200);
  assert.equal(selectedSchool, 'school-b');
  const patch = req({ decision: 'reject', review_note: 'Проверено' }, 'PATCH'); patch.url = `/api/v1/deletion-requests/${requestId}`;
  assert.deepEqual(await handler(patch), { status: 200, body: { ok: true, status: 'rejected' } });
  assert.deepEqual(rejected, [requestId, 'school-b', 'other-admin', 'Проверено']);
  const unsupported = req({ decision: 'approve' }, 'PATCH'); unsupported.url = `/api/v1/deletion-requests/${requestId}`;
  assert.equal((await handler(unsupported)).status, 403);
  actor = { id: 'council-id', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(request)).status, 403);
  const councilPatch = req({ decision: 'reject', review_note: 'Проверено' }, 'PATCH'); councilPatch.url = `/api/v1/deletion-requests/${requestId}`;
  assert.equal((await handler(councilPatch)).status, 403);
});
test('a suspended school administrator cannot reject school account deletion requests', async () => {
  let rejected = 0;
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'admin' }),
    resolveActor: async () => ({ id: 'admin-id', school_id: 'school-a', role: 'school_admin' }),
    repository: {
      getActiveAccountSuspension: async () => ({ reason: 'test', expires_at: '2099-01-01T00:00:00Z' }),
      rejectAccountDeletionRequest: async () => { rejected++; return true; },
    } });
  const patch = req({ decision: 'reject', review_note: 'Проверено' }, 'PATCH');
  patch.url = `/api/v1/deletion-requests/${requestId}`;
  assert.deepEqual(await handler(patch), { status: 403, body: { ok: false, error: 'account_suspended' } });
  assert.equal(rejected, 0);
});
test('council members can read only their own school-scoped deletion request history', async () => {
  let args;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'council' }),
    resolveActor: async () => ({ id: 'council-id', school_id: 'school-a', role: 'council_member' }),
    repository: { getActiveAccountSuspension: async () => null, listOwnAccountDeletionRequests: async (...values) => { args = values; return [{ request_id: 'synthetic', status: 'pending' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/deletion-requests';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(args, ['school-a', 'council-id']);
  assert.deepEqual(response.body.requests, [{ request_id: 'synthetic', status: 'pending' }]);
});
test('direct same-origin school-account deletion is dispatched to the Russian deletion handler', async () => {
  const targetId = '22222222-2222-4222-8222-222222222222';
  const admin = { id: '33333333-3333-4333-8333-333333333333', school_id: 'school-a', role: 'school_admin' };
  const now = Date.now(); let finalized;
  const handler = createListingsApi({
    authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'admin-subject', authenticated_at: Math.floor(now / 1000) }),
    resolveActor: async () => admin,
    repository: {
      getActiveAccountSuspension: async () => null,
      listAccountMediaKeys: async () => [],
      beginAdminAccountDeletion: async input => ({ ok: true, id: targetId, issuer: 'https://issuer.example', subject: 'target-subject', school_id: input.schoolId, role: 'student', claim_token: 'claim-a' }),
      finishAccountDeletion: async input => { finalized = input; return { ok: true, deleted: true }; },
      restoreAccountAfterDeletionFailure: async () => true,
    },
    pendingImages: { listUserObjects: async () => [], listAccountObjects: async (_id, keys = []) => keys, delete: async () => {} }, now: () => now,
  });
  const request = req({ confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА' }, 'DELETE');
  request.url = `/api/v1/school/accounts/${targetId}`;
  const response = await handler(request);
  assert.deepEqual(response, { status: 200, body: { ok: true, deleted: true, removed_images: 0 } });
  assert.equal(finalized.userId, targetId);
  assert.equal(finalized.claimToken, 'claim-a');
});
test('API requires verified identity and database profile before writing', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null, repository: { getActiveAccountSuspension: async () => null, createListing: async () => { writes++; } } });
  const response = await handler(req({ title: 'x' }));
  assert.equal(response.status, 401); assert.equal(writes, 0);
});
test('API maps identity to database profile and persists unreviewed content as pending', async () => {
  let record;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }), resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: { getActiveAccountSuspension: async () => null, createListing: async (x) => { record = x; return { id: 'synthetic-listing' }; } } });
  const response = await handler(req({ title: 'Book', description: 'School book', category: 'Учёба', user_id: 'forged' }));
  assert.equal(response.status, 201); assert.equal(record.user_id, 'synthetic-user'); assert.equal(record.status, 'pending');
});
test('public listing read needs no student identity and returns only repository-approved projection', async () => {
  const safeRow = { id: 'synthetic-listing', title: 'Book', status: 'active' };
  const handler = createListingsApi({ authenticate: async () => { throw new Error('public read must not authenticate'); },
    resolveActor: async () => { throw new Error('public read must not resolve a profile'); },
    repository: { getActiveAccountSuspension: async () => null, listActiveListings: async () => [safeRow] } });
  const request = req({}, 'GET'); request.url = '/api/v1/listings';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, listings: [safeRow] });
});

test('contacting a listing derives the recipient on the server and sends only reviewed text', async () => {
  const sender = '11111111-1111-4111-8111-111111111111';
  const recipient = '22222222-2222-4222-8222-222222222222';
  const listingId = '33333333-3333-4333-8333-333333333333';
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ id: sender, school_id: 'school-a', role: 'student' }),
    review: async ({ text }) => ({ action: text === 'hello' ? 'ok' : 'pending', reason_code: 'review_pending' }),
    repository: { getActiveAccountSuspension: async () => null,
      getListingContactRecipient: async (id, actorId, schoolId) => id === listingId && actorId === sender && schoolId === 'school-a' ? recipient : null,
      createMessage: async record => { saved = record; return { id: '44444444-4444-4444-8444-444444444444' }; },
    } });
  const request = req({ body: 'hello', receiver_id: '55555555-5555-4555-8555-555555555555' });
  request.url = `/api/v1/listings/${listingId}/contact`;
  const response = await handler(request);
  assert.equal(response.status, 201);
  assert.equal(saved.sender_id, sender);
  assert.equal(saved.receiver_id, recipient);
  assert.equal(saved.school_id, 'school-a');
  assert.equal(saved.body, 'hello');
  assert.equal(saved.listing_id, listingId, 'the listing contact route links the conversation to the validated listing');
});

test('listing contact rejects unavailable or cross-school listing without storing a message', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'synthetic' }),
    resolveActor: async () => ({ id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, getListingContactRecipient: async () => null, createMessage: async () => { writes++; } } });
  const request = req({ body: 'hello' });
  request.url = '/api/v1/listings/33333333-3333-4333-8333-333333333333/contact';
  const response = await handler(request);
  assert.equal(response.status, 404);
  assert.equal(writes, 0);
});
test('public listing read fails closed when the database is unavailable', async () => {
  const handler = createListingsApi({ repository: { getActiveAccountSuspension: async () => null, listActiveListings: async () => { throw new Error('offline'); } } });
  const request = req({}, 'GET'); request.url = '/api/v1/listings';
  const response = await handler(request);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'database_unavailable');
});

test('pending moderation queue is restricted to the authenticated school staff profile', async () => {
  let schoolScope;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'verified' }),
    resolveActor: async () => ({ id: 'staff-id', school_id: 'school-a', role: 'school_admin' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingListings: async schoolId => { schoolScope = schoolId; return [{ id: 'pending-id', photo_status: 'pending' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/listings/moderation';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.equal(schoolScope, 'school-a');
  assert.deepEqual(response.body.listings, [{ id: 'pending-id', photo_status: 'pending' }]);

  let reads = 0;
  const student = createListingsApi({ authenticate: async () => ({ subject: 'verified' }),
    resolveActor: async () => ({ id: 'student-id', school_id: 'school-a', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingListings: async () => { reads++; return []; } } });
  const denied = req({}, 'GET'); denied.url = '/api/v1/listings/moderation';
  assert.equal((await student(denied)).status, 403);
  assert.equal(reads, 0);
});

test('event review queue is school-scoped, staff-only, and does not query for students', async () => {
  let requestedSchool;
  const staff = createListingsApi({ authenticate: async () => ({ subject: 'verified' }),
    resolveActor: async () => ({ id: 'staff-id', school_id: 'school-a', role: 'council_member' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingEventReviews: async schoolId => { requestedSchool = schoolId; return [{ event_id: 'event-a', user_id: 'student-a' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/event-registrations/review';
  const response = await staff(request);
  assert.equal(response.status, 200);
  assert.equal(requestedSchool, 'school-a');
  assert.deepEqual(response.body.applications, [{ event_id: 'event-a', user_id: 'student-a' }]);

  let reads = 0;
  const student = createListingsApi({ authenticate: async () => ({ subject: 'verified' }),
    resolveActor: async () => ({ id: 'student-id', school_id: 'school-a', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingEventReviews: async () => { reads++; return []; } } });
  const denied = req({}, 'GET'); denied.url = '/api/v1/event-registrations/review';
  assert.equal((await student(denied)).status, 403);
  assert.equal(reads, 0);
});

test('unprovisioned Yandex identities can request a participant profile but cannot choose an app role', async () => {
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://login.yandex.ru', subject: 'verified-subject' }),
    resolveActor: async () => null,
    repository: { getActiveAccountSuspension: async () => null, createSchoolProfileRequest: async record => { saved = record; return { ok: true, status: 'pending', request_id: 'synthetic-request' }; } } });
  const request = req({ school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8а', role: 'school_admin', user_id: 'forged' });
  request.url = '/api/v1/profile-requests';
  const response = await handler(request);
  assert.equal(response.status, 202);
  assert.deepEqual(saved, { issuer: 'https://login.yandex.ru', subject: 'verified-subject', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'student', staff_position: '' });
  assert.equal(Object.hasOwn(saved, 'role'), false);

  let writes = 0;
  const denied = createListingsApi({ authenticate: async () => ({ issuer: 'https://login.yandex.ru', subject: 'verified-subject' }),
    repository: { getActiveAccountSuspension: async () => null, createSchoolProfileRequest: async () => { writes++; return { ok: true, status: 'pending' }; } } });
  const invalid = req({ school_id: 'unlisted-school', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' }); invalid.url = '/api/v1/profile-requests';
  assert.equal((await denied(invalid)).status, 400);
  assert.equal(writes, 0);
});

test('only same-school administrators can read or decide profile access requests', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let schoolId; let decision;
  const admin = createListingsApi({ authenticate: async () => ({ subject: 'admin' }),
    resolveActor: async () => ({ id: 'admin', school_id: 'lyceum_3', role: 'school_admin' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingSchoolProfileRequests: async id => { schoolId = id; return [{ request_id: requestId, first_name: 'Аня', class_name: '8А' }]; },
      reviewSchoolProfileRequest: async (...args) => { [decision, schoolId] = [args[3], args[1]]; return true; } } });
  const list = req({}, 'GET'); list.url = '/api/v1/profile-requests/review';
  assert.equal((await admin(list)).status, 200);
  assert.equal(schoolId, 'lyceum_3');
  const patch = req({ decision: 'approve' }, 'PATCH'); patch.url = `/api/v1/profile-requests/${requestId}`;
  assert.deepEqual(await admin(patch), { status: 200, body: { ok: true, status: 'approved' } });
  assert.equal(decision, 'approve');

  let reads = 0;
  const student = createListingsApi({ authenticate: async () => ({ subject: 'student' }),
    resolveActor: async () => ({ id: 'student', school_id: 'lyceum_3', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingSchoolProfileRequests: async () => { reads++; return []; }, reviewSchoolProfileRequest: async () => { reads++; return true; } } });
  const forbiddenList = req({}, 'GET'); forbiddenList.url = '/api/v1/profile-requests/review';
  const forbiddenDecision = req({ decision: 'approve' }, 'PATCH'); forbiddenDecision.url = `/api/v1/profile-requests/${requestId}`;
  assert.equal((await student(forbiddenList)).status, 403);
  assert.equal((await student(forbiddenDecision)).status, 403);
  assert.equal(reads, 0);
});

test('only an active school administrator can list and decide staff verification requests', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let decision;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'admin' }),
    resolveActor: async () => ({ id: 'admin-a', school_id: 'school-a', role: 'school_admin' }),
    repository: { getActiveAccountSuspension: async () => null,
      listPendingSchoolStaffVerifications: async schoolId => { assert.equal(schoolId, 'school-a'); return [{ user_id: userId, staff_position: 'Учитель' }]; },
      reviewSchoolStaffVerification: async input => { decision = input; return true; },
    } });
  const list = req({}, 'GET'); list.url = '/api/v1/staff-verifications';
  assert.equal((await handler(list)).body.requests[0].user_id, userId);
  const patch = req({ decision: 'approved' }, 'PATCH'); patch.url = `/api/v1/staff-verifications/${userId}`;
  assert.deepEqual(await handler(patch), { status: 200, body: { ok: true, status: 'approved' } });
  assert.deepEqual(decision, { userId, schoolId: 'school-a', reviewerId: 'admin-a', decision: 'approved' });

  let reads = 0;
  const student = createListingsApi({ authenticate: async () => ({ subject: 'student' }),
    resolveActor: async () => ({ id: 'student-a', school_id: 'school-a', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, listPendingSchoolStaffVerifications: async () => { reads++; return []; }, reviewSchoolStaffVerification: async () => { reads++; return true; } } });
  assert.equal((await student(list)).status, 403);
  assert.equal((await student(patch)).status, 403);
  assert.equal(reads, 0);
});

test('school catalog is a minimal public projection and needs no auth', async () => {
  const handler = createListingsApi({ authenticate: async () => { throw new Error('school catalog is public'); },
    schools: [{ id: 'lyceum_3', name: 'Лицей № 3', secret: 'hidden' }, { id: 'gymnasium_4', name: 'Гимназия № 4', secret: 'hidden' }] });
  const request = req({}, 'GET'); request.url = '/api/v1/schools';
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, schools: [
    { id: 'lyceum_3', name: 'Лицей № 3' }, { id: 'gymnasium_4', name: 'Гимназия № 4' },
  ] } });
});

test('profile endpoint authenticates and returns the database profile, never token roles', async () => {
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', role: 'admin' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: { getActiveAccountSuspension: async () => null,} });
  const request = req({}, 'GET'); request.url = '/api/v1/me';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.profile, { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' });
});
test('profile endpoint rejects missing authentication', async () => {
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null, repository: { getActiveAccountSuspension: async () => null,} });
  const request = req({}, 'GET'); request.url = '/api/v1/me';
  assert.equal((await handler(request)).status, 401);
});
test('profile identity update binds to the authenticated subject and ignores role or school fields', async () => {
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'own-subject' }),
    repository: { getActiveAccountSuspension: async () => null, updateOwnProfileIdentity: async (issuer, subject, fields) => { saved = { issuer, subject, ...fields }; return { id: 'own-id', role: 'student', school_id: 'school-a', ...fields }; } } });
  const request = req({ first_name: '  Аня ', last_name: 'Иванова', class_name: ' 8а ', role: 'school_admin', school_id: 'other-school', user_id: 'other-id' }, 'PATCH');
  request.url = '/api/v1/me';
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(saved, { issuer: 'https://issuer.example', subject: 'own-subject', first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'student', staff_position: '' });
  assert.equal(response.body.profile.role, 'student');
});

test('legacy profile edit preserves a nonstudent category and staff position', async () => {
  let saved;
  const identity = { issuer: 'https://issuer.example', subject: 'own-subject' };
  const handler = createListingsApi({ authenticate: async () => identity,
    resolveActor: async () => ({ id: 'own-id', school_id: 'school-a', role: 'student', person_type: 'school_staff', staff_position: 'Учитель', class_name: null }),
    repository: { getActiveAccountSuspension: async () => null, updateOwnProfileIdentity: async (_issuer, _subject, fields) => { saved = fields; return fields; } } });
  const request = req({ first_name: 'Анна', last_name: 'Иванова' }, 'PATCH'); request.url = '/api/v1/me';
  assert.equal((await handler(request)).status, 200);
  assert.deepEqual(saved, { first_name: 'Анна', last_name: 'Иванова', class_name: '', person_type: 'school_staff', staff_position: 'Учитель' });
});

test('profile identity update rejects invalid values before touching the repository', async () => {
  let writes = 0;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'own-subject' }),
    repository: { getActiveAccountSuspension: async () => null, updateOwnProfileIdentity: async () => { writes++; return {}; } } });
  const request = req({ first_name: '<script>', last_name: 'Иванова', class_name: '0А' }, 'PATCH'); request.url = '/api/v1/me';
  assert.equal((await handler(request)).status, 400);
  assert.equal(writes, 0);
});

test('profile identity update enforces the current FAM school class format', async () => {
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'own-subject' }),
    repository: { getActiveAccountSuspension: async () => null, updateOwnProfileIdentity: async (_issuer, _subject, fields) => { saved = fields; return fields; } } });
  for (const class_name of ['4А', '12А', '8Д', '8A']) {
    const request = req({ first_name: 'Аня', last_name: 'Тест', class_name }, 'PATCH'); request.url = '/api/v1/me';
    assert.equal((await handler(request)).status, 400, class_name);
  }
  for (const class_name of ['5А', '9К', '10Б', '11Г']) {
    const request = req({ first_name: 'Аня', last_name: 'Тест', class_name }, 'PATCH'); request.url = '/api/v1/me';
    assert.equal((await handler(request)).status, 200, class_name);
    assert.equal(saved.class_name, class_name);
  }
  const parent = req({ first_name: 'Анна', last_name: 'Иванова', person_type: 'parent', class_name: '' }, 'PATCH'); parent.url = '/api/v1/me';
  assert.equal((await handler(parent)).status, 200);
  assert.equal(saved.person_type, 'parent');
  const staff = req({ first_name: 'Анна', last_name: 'Иванова', person_type: 'school_staff', staff_position: 'Учитель математики', class_name: '' }, 'PATCH'); staff.url = '/api/v1/me';
  assert.equal((await handler(staff)).status, 200);
  assert.equal(saved.staff_position, 'Учитель математики');
});

test('favorites are scoped to the authenticated database actor', async () => {
  let listedFor;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', user_id: 'forged-user' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, listFavoriteIds: async (userId) => { listedFor = userId; return ['active-listing']; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/favorites';
  const response = await handler(request);
  assert.equal(listedFor, 'synthetic-user');
  assert.deepEqual(response.body, { ok: true, favorite_ids: ['active-listing'] });
});

test('favorite writes use only the authenticated actor and return 404 for non-active listings', async () => {
  let call;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, setFavorite: async (...args) => { call = args; return args[1] === '11111111-1111-4111-8111-111111111111'; } } });
  const request = req({ user_id: 'forged-user' }, 'PUT'); request.url = '/api/v1/listings/11111111-1111-4111-8111-111111111111/favorite';
  const response = await handler(request);
  assert.deepEqual(call, ['synthetic-user', '11111111-1111-4111-8111-111111111111', true]);
  assert.equal(response.status, 200);
  const missing = req({}, 'PUT'); missing.url = '/api/v1/listings/22222222-2222-4222-8222-222222222222/favorite';
  assert.equal((await handler(missing)).status, 404);
});

test('ordinary students can delete only their own listing and media cleanup stays server-side', async () => {
  const listingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = '11111111-1111-4111-8111-111111111111';
  let actor = { id: userId, role: 'student', school_id: 'school-a' };
  const calls = [];
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: actor.id }),
    resolveActor: async () => actor,
    pendingImages: { delete: async key => { calls.push(['delete-image', key]); } },
    repository: { getActiveAccountSuspension: async () => null,
      listOwnActiveListingIds: async id => id === userId ? [listingId] : [],
      listOwnListingSummaries: async id => id === userId ? [{ id: listingId, status: 'pending', title: 'Синтетика' }] : [],
      deleteOwnListing: async (id, target) => {
        calls.push(['delete-listing', id, target]);
        return id === userId && target === listingId ? { id: target, media_cleanup: { object_key: 'pending/user/image.webp', claim_token: 'claim-1' } } : null;
      },
      finishPendingImageCleanup: async (...args) => { calls.push(['finish-cleanup', ...args]); return true; },
    } });
  const own = req({}, 'GET'); own.url = '/api/v1/me/listings';
  assert.deepEqual((await handler(own)).body.listing_ids, [listingId]);
  assert.deepEqual((await handler(own)).body.listings, [{ id: listingId, status: 'pending', title: 'Синтетика' }]);
  const remove = req({}, 'DELETE'); remove.url = `/api/v1/listings/${listingId}`;
  assert.deepEqual(await handler(remove), { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.deepEqual(calls, [
    ['delete-listing', userId, listingId],
    ['delete-image', 'pending/user/image.webp'],
    ['finish-cleanup', 'pending/user/image.webp', 'claim-1', true],
  ]);
  actor = { id: '22222222-2222-4222-8222-222222222222', role: 'student', school_id: 'school-a' };
  assert.equal((await handler(remove)).status, 404);
  actor = { id: '33333333-3333-4333-8333-333333333333', role: 'school_admin', school_id: 'school-a' };
  assert.equal((await handler(remove)).status, 403);
});

test('school administrators require fresh Yandex auth to delete another member listing', async () => {
  const listingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const adminId = '11111111-1111-4111-8111-111111111111';
  let identity = { issuer: 'issuer', subject: 'admin', authenticated_at: 1_800_000_000 };
  let context = { user_id: '22222222-2222-4222-8222-222222222222', school_id: 'school-a', category: 'Книги' };
  let deleted = 0; const calls = [];
  const handler = createListingsApi({ authenticate: async () => identity,
    resolveActor: async () => ({ id: adminId, role: 'school_admin', school_id: 'school-a' }),
    now: () => 1_800_000_000_000,
    pendingImages: { delete: async key => calls.push(['image', key]) },
    repository: {
      getActiveAccountSuspension: async () => null,
      getSchoolListingDeletionContext: async input => { calls.push(['context', input]); return context; },
      deleteSchoolListing: async input => { calls.push(['delete', input]); deleted++; return {
        ok: true, id: listingId, media_cleanup: { object_key: 'pending/owner/image.webp', claim_token: 'claim' },
      }; },
      finishPendingImageCleanup: async (...args) => { calls.push(['finish', ...args]); return true; },
    } });
  const remove = req({ confirmation: 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ' }, 'DELETE');
  remove.url = `/api/v1/school/listings/${listingId}`;
  identity.authenticated_at = null;
  assert.equal((await handler(remove)).body.error, 'fresh_authentication_required');
  assert.equal(deleted, 0);
  identity.authenticated_at = 1_800_000_000;
  const freshRemove = req({ confirmation: 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ' }, 'DELETE');
  freshRemove.url = remove.url;
  assert.deepEqual(await handler(freshRemove), { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.equal(deleted, 1);
  assert.deepEqual(calls.slice(-3).map(call => call[0]), ['delete', 'image', 'finish']);
  context = { user_id: adminId, school_id: 'school-a', category: 'Афиша' };
  identity.authenticated_at = null;
  const ownRemove = req({ confirmation: 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ' }, 'DELETE');
  ownRemove.url = remove.url;
  assert.equal((await handler(ownRemove)).status, 200, 'owner can remove their own listing without the extra freshness gate');
  const wrongConfirmation = req({ confirmation: 'delete' }, 'DELETE'); wrongConfirmation.url = remove.url;
  assert.equal((await handler(wrongConfirmation)).body.error, 'confirmation_required');
  context = null;
  const unavailableRemove = req({ confirmation: 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ' }, 'DELETE');
  unavailableRemove.url = remove.url;
  assert.equal((await handler(unavailableRemove)).status, 404, 'cross-school or missing listing remains unavailable');
});

test('own listing identifiers are not exposed to staff or unprofiled identities', async () => {
  let actor = { id: 'staff-id', role: 'school_admin' };
  let queries = 0;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'staff' }), resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null, listOwnActiveListingIds: async () => { queries++; return ['secret-listing-id']; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/me/listings';
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, listing_ids: [], listings: [] } });
  assert.equal(queries, 0);
  actor = null;
  assert.equal((await handler(request)).status, 403);
});

test('favorites fail closed when the database adapter is unavailable', async () => {
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }), repository: { getActiveAccountSuspension: async () => null,} });
  const request = req({}, 'GET'); request.url = '/api/v1/favorites';
  assert.equal((await handler(request)).status, 503);
});

test('idea submission is authenticated and bound to the database profile', async () => {
  let saved;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', user_id: 'forged-user' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, createIdea: async record => { saved = record; return { id: 'synthetic-idea' }; } } });
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
    repository: { getActiveAccountSuspension: async () => null, createMessage: async () => { writes++; return { id: 'unexpected' }; } } });
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
    repository: { getActiveAccountSuspension: async () => null, createMessage: async record => { saved = record; return { id: 'synthetic-message' }; } } });
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
    repository: { getActiveAccountSuspension: async () => null, listMessages: async (userId, schoolId) => { owner = [userId, schoolId]; return [{ id: 'owned-message' }]; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/messages';
  const response = await handler(request);
  assert.deepEqual(owner, ['synthetic-user', 'synthetic-school']);
  assert.deepEqual(response.body, { ok: true, messages: [{ id: 'owned-message' }] });
});

test('message read rejects missing identity before querying the database', async () => {
  let reads = 0;
  const handler = createListingsApi({ authenticate: async () => null, resolveActor: async () => null,
    repository: { getActiveAccountSuspension: async () => null, listMessages: async () => { reads++; return []; } } });
  const request = req({}, 'GET'); request.url = '/api/v1/messages';
  assert.equal((await handler(request)).status, 401);
  assert.equal(reads, 0);
});

test('only the authenticated recipient can mark a message read', async () => {
  let args;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, markMessageRead: async (...values) => { args = values; return true; } } });
  const request = req({}, 'PATCH'); request.url = '/api/v1/messages/11111111-1111-4111-8111-111111111111/read';
  const response = await handler(request);
  assert.deepEqual(args, ['synthetic-user', 'synthetic-school', '11111111-1111-4111-8111-111111111111']);
  assert.equal(response.body.is_read, true);
});

test('bulk message read accepts bounded UUIDs and scopes every update to the verified profile', async () => {
  let call;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub' }),
    resolveActor: async () => ({ id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, markMessagesRead: async (...args) => { call = args; return 1; } } });
  const request = req({ message_ids: ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'] });
  request.url = '/api/v1/messages/read';
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, updated: 1 } });
  assert.deepEqual(call, ['synthetic-user', 'synthetic-school', ['11111111-1111-4111-8111-111111111111']]);
  const invalid = req({ message_ids: ['not-a-uuid'] }); invalid.url = request.url;
  assert.equal((await handler(invalid)).status, 400);
});

test('listing moderation trusts database role and school scope, not token claims or request fields', async () => {
  let call;
  const id = '11111111-1111-4111-8111-111111111111';
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'oidc-sub', role: 'school_admin' }),
    resolveActor: async () => ({ id: 'admin-id', school_id: 'school-a', role: 'school_admin' }),
    repository: { getActiveAccountSuspension: async () => null, moderateListing: async (...args) => { call = args; return true; } } });
  const request = req({ decision: 'approve', school_id: 'school-b', status: 'active' }, 'PATCH');
  request.url = `/api/v1/listings/${id}/moderation`;
  const response = await handler(request);
  assert.deepEqual(call, [id, 'school-a', 'active']);
  assert.deepEqual(response, { status: 200, body: { ok: true, status: 'active' } });
});

test('listing moderation rejects student role and invalid decisions before repository access', async () => {
  let writes = 0;
  const base = { authenticate: async () => ({ subject: 'oidc-sub', role: 'school_admin' }),
    repository: { getActiveAccountSuspension: async () => null, moderateListing: async () => { writes++; return true; } } };
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
    repository: { getActiveAccountSuspension: async () => null, registerForEvent: async (...args) => { registeredAs = args; return { event_id: args[0], user_id: args[1], status: 'confirmed' }; } } });
  const request = registrationRequest();
  const response = await handler(request);
  assert.deepEqual(registeredAs, [eventId, 'synthetic-registrant']);
  assert.deepEqual(response, { status: 201, body: { ok: true, registration: { event_id: eventId, user_id: 'synthetic-registrant', status: 'confirmed' } } });

  const full = createListingsApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: 'u', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, registerForEvent: async () => { throw Object.assign(new Error('full'), { code: 'no_seats_available' }); } } });
  const fullResponse = await full(registrationRequest());
  assert.equal(fullResponse.status, 409);
  assert.equal(fullResponse.body.error, 'no_seats_available');
});

test('event applicant names are visible only to same-school council roles', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let scope;
  const repository = { getActiveAccountSuspension: async () => null, listEventApplicants: async (...args) => { scope = args; return [{ first_name: 'Тест', class_name: '8А', status: 'pending' }]; } };
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
    repository: { getActiveAccountSuspension: async () => null, moderateEventRegistration: async (...args) => { writes++; assert.deepEqual(args, [eventId, userId, 'organizer', 'school-a', 'confirmed']); return true; } } });
  const request = req({ decision: 'approve' }, 'PATCH'); request.url = `/api/v1/listings/${eventId}/registrations/${userId}`;
  assert.equal((await makeHandler('student')(request)).status, 403);
  assert.equal(writes, 0);
  assert.deepEqual(await makeHandler('council_member')(request), { status: 200, body: { ok: true, status: 'confirmed' } });
});

test('event occupancy is a public count for active events without registration identities', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  let active = true;
  const handler = createListingsApi({ authenticate: async () => { throw new Error('public occupancy must not authenticate'); },
    repository: { getActiveAccountSuspension: async () => null, getPublicEventOccupancy: async id => {
      assert.equal(id, eventId); return active ? 3 : null;
    } } });
  const request = req({}, 'GET'); request.url = `/api/v1/listings/${eventId}/occupancy`;
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, taken: 3 } });
  active = false;
  assert.deepEqual(await handler(request), { status: 404, body: { ok: false, error: 'event_unavailable' } });
});

test('idea image review queue and decisions are limited to authorized same-school staff', async () => {
  let actor = { id: '66666666-6666-4666-8666-666666666666', school_id: 'school-a', role: 'council_member' };
  let listedSchool; let listedReviewer; let reviewed;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'staff' }), resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null, listPendingSchoolIdeas: async (schoolId, reviewerId, role) => { listedSchool = schoolId; listedReviewer = reviewerId; assert.equal(role, actor.role); return [{ id: 'idea-a', ai_status: 'approved', image_status: 'pending' }]; },
      reviewSchoolIdeaImages: async value => { reviewed = value; return value.schoolId === 'school-a'; } } });
  const list = req({}, 'GET'); list.url = '/api/v1/school/ideas';
  assert.deepEqual(await handler(list), { status: 200, body: { ok: true, ideas: [{ id: 'idea-a', ai_status: 'approved', image_status: 'pending' }] } });
  assert.equal(listedSchool, 'school-a');
  assert.equal(listedReviewer, actor.id);
  const approve = req({ decision: 'approve' }, 'PATCH'); approve.url = '/api/v1/school/ideas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/images';
  assert.deepEqual(await handler(approve), { status: 200, body: { ok: true, image_status: 'approved' } });
  assert.equal(reviewed.ideaId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(reviewed.reviewerId, actor.id);
  actor = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', school_id: 'school-b', role: 'council_member' };
  const crossSchoolApprove = req({ decision: 'approve' }, 'PATCH');
  crossSchoolApprove.url = approve.url;
  assert.equal((await handler(crossSchoolApprove)).status, 404, 'the repository rejects cross-school reviews');
  actor = { id: 'student-a', school_id: 'school-a', role: 'student' };
  assert.equal((await handler(list)).status, 403);
});

test('idea text moderation requires school staff and records a decision only through the scoped repository', async () => {
  let actor = { id: '55555555-5555-4555-8555-555555555555', school_id: 'school-a', role: 'school_admin' };
  let review;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'staff' }), resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null, reviewSchoolIdeaText: async value => { review = value; return value.schoolId === actor.school_id; } } });
  const approve = req({ decision: 'approve' }, 'PATCH'); approve.url = '/api/v1/school/ideas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/moderation';
  assert.deepEqual(await handler(approve), { status: 200, body: { ok: true, ai_status: 'approved' } });
  assert.deepEqual(review, { ideaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schoolId: 'school-a', reviewerId: actor.id, decision: 'approve' });
  actor = { id: '66666666-6666-4666-8666-666666666666', school_id: 'school-a', role: 'council_member' };
  assert.equal((await handler(approve)).status, 403, 'council cannot directly decide AI-pending school text');
  actor = { id: 'student-a', school_id: 'school-a', role: 'student' };
  assert.equal((await handler(approve)).status, 403);
});

test('school idea workflow is same-school staff only and accepts only bounded lifecycle statuses', async () => {
  const ideaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let actor = { id: 'staff-a', school_id: 'school-a', role: 'council_member' };
  let update;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'staff' }), resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null,
      listSchoolIdeaWorkflow: async schoolId => [{ id: ideaId, school_id: schoolId, admin_status: 'new' }],
      updateSchoolIdeaWorkflow: async value => { update = value; return value.schoolId === 'school-a'; } } });
  const list = req({}, 'GET'); list.url = '/api/v1/school/ideas/workflow';
  assert.deepEqual(await handler(list), { status: 200, body: { ok: true, ideas: [{ id: ideaId, school_id: 'school-a', admin_status: 'new' }] } });
  const patch = status => { const request = req({ status }, 'PATCH'); request.url = `/api/v1/school/ideas/workflow/${ideaId}/status`; return request; };
  assert.deepEqual(await handler(patch('in_progress')), { status: 200, body: { ok: true, admin_status: 'in_progress' } });
  assert.deepEqual(update, { ideaId, schoolId: 'school-a', reviewerId: 'staff-a', status: 'in_progress' });
  assert.equal((await handler(patch('new'))).status, 400);
  actor = { id: 'student-a', school_id: 'school-a', role: 'student' };
  assert.equal((await handler(list)).status, 403);
  actor = { id: 'staff-b', school_id: 'school-b', role: 'council_member' };
  assert.deepEqual(await handler(patch('done')), { status: 404, body: { ok: false, error: 'idea_unavailable' } });
});

test('idea deletion requires owner scope or explicit same-school administrator confirmation', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const owner = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', school_id: 'school-a', role: 'student' };
  let actor = owner; let identity = { subject: 'owner' }; let deleted = 0; const removed = []; const finished = [];
  const repository = { getActiveAccountSuspension: async () => null,
    getSchoolIdeaDeletionContext: async ({ ideaId, schoolId }) => ideaId === id && schoolId === 'school-a' ? { user_id: owner.id, school_id: schoolId } : null,
    deleteSchoolIdea: async input => { deleted++; return { ok: input.actorId === actor.id, own: input.actorId === owner.id, media_cleanup: [{ object_key: 'pending/bbbb/photo.webp', claim_token: 'claim-a' }] }; },
    finishPendingImageCleanup: async (...args) => { finished.push(args); return true; },
  };
  const handler = createListingsApi({ authenticate: async () => identity, resolveActor: async () => actor, repository,
    pendingImages: { delete: async key => { removed.push(key); } }, now: () => 1_000_000 });
  const deletion = (body = null) => { const request = req(body ?? {}, 'DELETE'); request.url = `/api/v1/ideas/${id}`; return request; };
  assert.deepEqual(await handler(deletion()), { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.equal(deleted, 1);
  assert.deepEqual(removed, ['pending/bbbb/photo.webp']);
  assert.equal(finished[0][2], true);

  actor = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', school_id: 'school-a', role: 'school_admin' };
  identity = { subject: 'admin' };
  assert.equal((await handler(deletion({ confirmation: 'неверно' }))).status, 400);
  assert.equal(deleted, 1, 'the exact confirmation is required before repository deletion');
  assert.deepEqual(await handler(deletion({ confirmation: 'УДАЛИТЬ ИДЕЮ ШКОЛЫ' })), { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.equal(deleted, 2, 'a same-school administrator can perform the source-authorized delete with explicit confirmation');

  actor = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', school_id: 'school-a', role: 'council_member' };
  identity = { subject: 'council', authenticated_at: 990 };
  assert.equal((await handler(deletion({ confirmation: 'УДАЛИТЬ ИДЕЮ ШКОЛЫ' }))).status, 403);
});

test('notification read state is always owned by the authenticated profile and bounded', async () => {
  const actor = { id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a', role: 'student' };
  const saved = [];
  let listedOwner;
  const handler = createListingsApi({ authenticate: async () => ({ subject: 'student' }), resolveActor: async () => actor,
    repository: { getActiveAccountSuspension: async () => null,
      listNotificationReadStates: async owner => { listedOwner = owner; return [{ notification_key: 'release:test' }]; },
      saveNotificationReadStates: async (owner, keys) => { saved.push({ owner, keys }); return true; },
    } });
  const list = req({}, 'GET'); list.url = '/api/v1/notification-reads';
  assert.deepEqual(await handler(list), { status: 200, body: { ok: true, notification_keys: ['release:test'] } });
  assert.equal(listedOwner, actor.id);
  const save = req({ notification_keys: ['school-listing:abc', 'dismissed:release:test', 'school-listing:abc'] });
  save.url = '/api/v1/notification-reads';
  assert.deepEqual(await handler(save), { status: 200, body: { ok: true } });
  assert.deepEqual(saved, [{ owner: actor.id, keys: ['school-listing:abc', 'dismissed:release:test'] }]);
  const invalid = req({ notification_keys: ['bad\nkey'] }); invalid.url = save.url;
  assert.equal((await handler(invalid)).status, 400);
  const oversized = req({ notification_keys: Array.from({ length: 101 }, (_, i) => `key:${i}`) }); oversized.url = save.url;
  assert.equal((await handler(oversized)).status, 400);
});
