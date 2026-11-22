Warning: truncated output (original token count: 21033)
Total output lines: 1172

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListingsApi } from '../services/listings-api.mjs';
import { createRoleEmailVerification } from '../services/role-email-verification.mjs';
function req(body = {}, method = 'POST') {
  const request = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = '/api/v1/listings';
  return request;
}
test('school listing notifications use a private bounded projection scoped to the active user school', async () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  let scope;
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'issuer', subject: 'student' }),
    resolveActor: async () => ({ id: ownerId, school_id: 'school-a', role: 'student' }),
    repository: { listRecentSchoolNotificationListings: async (...args) => {
      scope = args;
      return [{ id: 'listing-a', title: 'Синтетическая новость'.repeat(10), is_event: true,
        created_at: '2026-11-22T10:00:00Z', school_id: 'private-school', user_id: 'private-owner', image_key: 'private-key' }];
    } } });
  const request = req({}, 'GET'); request.url = '/api/v1/notifications/listings';
  const result = await handler(request);
  assert.equal(result.status, 200);
  assert.deepEqual(scope, ['school-a', ownerId]);
  assert.deepEqual(Object.keys(result.body.listings[0]).sort(), ['created_at', 'id', 'is_event', 'title']);
  assert.equal(result.body.listings[0].title.length, 80);

  const guest = createListingsApi({ authenticate: async () => null, repository: { listRecentSchoolNotificationListings: async () => { throw new Error('must not read'); } } });
  assert.equal((await guest(request)).status, 401);
});

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
  assert.equal(result.body.email_verified, false);
  assert.equal(result.body.email_verification_available, false);
  assert.deepEqual(Object.keys(result.body.request).sort(), ['created_at', 'request_id', 'school_id', 'status']);
});
test('role requests use a fixed allowlist, active student profile, and school-admin review scope', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let savedRole; let reviewSchool; let reviewAction;
  let actor = { id: 'student-id', school_id: 'school-a', role: 'student', active: true };
  const handler = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.example', subject: 'student' }),
    resolveActor: async () => actor,
    emailVerification: { available: true, isVerified: async () => true },
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
  assert.equal(Object.hasOwn(queued.body.requests[0], 'user_id'), false, 'review queue expo…14033 tokens truncated…trant', status: 'confirmed' } } });

  const full = createListingsApi({ authenticate: async () => ({ subject: 'x' }), resolveActor: async () => ({ id: 'u', school_id: 'school-a', role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, registerForEvent: async () => { throw Object.assign(new Error('full'), { code: 'no_seats_available' }); } } });
  const fullResponse = await full(registrationRequest());
  assert.equal(fullResponse.status, 409);
  assert.equal(fullResponse.body.error, 'no_seats_available');
});

test('event applicant names are visible to the owner or same-school council roles only', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const scopes = [];
  const repository = { getActiveAccountSuspension: async () => null, listEventApplicants: async (...args) => {
    scopes.push(args);
    return ['owner', 'council'].includes(args[2]) ? [{ first_name: 'Тест', class_name: '8А', status: 'pending' }] : [];
  } };
  const student = createListingsApi({ authenticate: async () => ({ subject: 's' }),
    resolveActor: async () => ({ id: 'student', role: 'student', school_id: 'school-a' }), repository });
  const studentRequest = req({}, 'GET'); studentRequest.url = `/api/v1/listings/${id}/registrations`;
  assert.deepEqual(await student(studentRequest), { status: 200, body: { ok: true, applicants: [] } });
  assert.deepEqual(scopes[0], [id, 'school-a', 'student']);
  const owner = createListingsApi({ authenticate: async () => ({ subject: 's' }),
    resolveActor: async () => ({ id: 'owner', role: 'student', school_id: 'school-a' }), repository });
  const ownerRequest = req({}, 'GET'); ownerRequest.url = `/api/v1/listings/${id}/registrations`;
  assert.equal((await owner(ownerRequest)).body.applicants.length, 1);
  assert.deepEqual(scopes[1], [id, 'school-a', 'owner']);
  const council = createListingsApi({ authenticate: async () => ({ subject: 's', school_id: 'forged' }),
    resolveActor: async () => ({ id: 'council', role: 'council_member', school_id: 'school-a' }), repository });
  const councilRequest = req({}, 'GET'); councilRequest.url = `/api/v1/listings/${id}/registrations`;
  const response = await council(councilRequest);
  assert.deepEqual(scopes[2], [id, 'school-a', 'council']);
  assert.deepEqual(response.body, { ok: true, applicants: [{ first_name: 'Тест', class_name: '8А', status: 'pending' }] });
});

test('event registration review delegates owner and same-school reviewer checks to the repository', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const makeHandler = (id, role, authorized) => createListingsApi({ authenticate: async () => ({ subject: 'x' }),
    resolveActor: async () => ({ id, school_id: 'school-a', role }),
    repository: { getActiveAccountSuspension: async () => null, moderateEventRegistration: async (...args) => { calls.push(args); return authorized; } } });
  const request = () => { const value = req({ decision: 'approve' }, 'PATCH'); value.url = `/api/v1/listings/${eventId}/registrations/${userId}`; return value; };
  assert.deepEqual(await makeHandler('student', 'student', false)(request()), { status: 404, body: { ok: false, error: 'registration_unavailable' } });
  assert.deepEqual(calls[0], [eventId, userId, 'student', 'school-a', 'confirmed']);
  assert.deepEqual(await makeHandler('organizer', 'student', true)(request()), { status: 200, body: { ok: true, status: 'confirmed' } });
  assert.deepEqual(calls[1], [eventId, userId, 'organizer', 'school-a', 'confirmed']);
  assert.deepEqual(await makeHandler('council', 'council_member', true)(request()), { status: 200, body: { ok: true, status: 'confirmed' } });
});

test('event occupancy requires an authenticated member of the event school', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  let active = true;
  let schoolId = 'school-a'; let requestedSchool;
  let identity = null; let reads = 0;
  const handler = createListingsApi({ authenticate: async () => identity,
    resolveActor: async () => ({ id: 'synthetic-user', school_id: schoolId, role: 'student' }),
    repository: { getActiveAccountSuspension: async () => null, getPublicEventOccupancy: async (id, scope) => {
      reads++; assert.equal(id, eventId); requestedSchool = scope; return active && scope === 'school-a' ? 3 : null;
    } } });
  const request = req({}, 'GET'); request.url = `/api/v1/listings/${eventId}/occupancy`;
  assert.deepEqual(await handler(request), { status: 404, body: { ok: false, error: 'event_unavailable' } });
  assert.equal(reads, 0);
  identity = { issuer: 'issuer', subject: 'member' };
  assert.deepEqual(await handler(request), { status: 200, body: { ok: true, taken: 3 } });
  assert.equal(requestedSchool, 'school-a');
  schoolId = 'school-b';
  assert.deepEqual(await handler(request), { status: 404, body: { ok: false, error: 'event_unavailable' } });
  schoolId = 'school-a';
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
