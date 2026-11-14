import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
import { createSuspensionWriteGuard } from '../app/backend/auth/suspension-write-guard.mjs';
import { createListingsApi } from '../app/backend/services/listings-api.mjs';

// This script is intentionally hard-wired to the disposable local database.
const driver = new Driver('grpc://127.0.0.1:2136/local');
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => { const statement = client(strings, ...values); statement.on('error', () => {}); return statement; };
  sql.begin = client.begin.bind(client);
  const repo = createYdbListingsRepository(sql);
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name, city) VALUES ('https://issuer.synthetic', 'subject-1', 'synthetic-user', 'synthetic-school', 'student', true, 'Тест', 'Ученик', '8А', 'Казань');`;
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active) VALUES
    ('https://issuer.synthetic', 'subject-2', '11111111-1111-4111-8111-111111111111', 'synthetic-school', 'student', true),
    ('https://issuer.synthetic', 'subject-admin', '33333333-3333-4333-8333-333333333333', 'synthetic-school', 'school_admin', true),
    ('https://issuer.synthetic', 'subject-role-student', '55555555-5555-4555-8555-555555555555', 'synthetic-school', 'student', true),
    ('https://issuer.synthetic', 'subject-3', '22222222-2222-4222-8222-222222222222', 'other-school', 'student', true),
    ('https://issuer.synthetic', 'subject-council', '66666666-6666-4666-8666-666666666666', 'synthetic-school', 'council_member', true),
    ('https://issuer.synthetic', 'subject-role-target', '77777777-7777-4777-8777-777777777777', 'synthetic-school', 'council_member', true),
    ('https://issuer.synthetic', 'subject-admin-target', '88888888-8888-4888-8888-888888888888', 'synthetic-school', 'school_admin', true),
    ('https://issuer.synthetic', 'subject-delete-target', '99999999-9999-4999-8999-999999999999', 'synthetic-school', 'council_member', true),
    ('https://issuer.synthetic', 'subject-lyceum-admin', '44444444-4444-4444-8444-444444444444', 'lyceum_3', 'school_admin', true);`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
  const authenticate = async req => ({ issuer: 'https://issuer.synthetic', subject: ['Bearer synthetic-registrant', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? 'subject-2'
      : req.headers.authorization === 'Bearer synthetic-admin' ? 'subject-admin'
        : req.headers.authorization === 'Bearer synthetic-role-student' ? 'subject-role-student'
        : req.headers.authorization === 'Bearer synthetic-council' ? 'subject-council'
        : req.headers.authorization === 'Bearer synthetic-new-student' ? 'subject-new'
          : req.headers.authorization === 'Bearer synthetic-other-school' ? 'subject-3'
          : req.headers.authorization === 'Bearer synthetic-lyceum-admin' ? 'subject-lyceum-admin' : 'subject-1',
    authenticated_at: ['Bearer synthetic-admin', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? Math.floor(Date.now() / 1000) : null });
  const deletedMediaKeys = [];
  const accountMediaKeys = new Set();
  const listingsApi = createSuspensionWriteGuard({ authenticate, resolveActor, repository: repo })(createListingsApi({
    authenticate,
    resolveActor,
    repository: repo,
    pendingImages: {
      delete: async key => { deletedMediaKeys.push(key); accountMediaKeys.delete(key); },
      listUserObjects: async userId => [...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)),
    },
  }));
  const apiRequest = (method, url, token, body = {}) => {
    const request = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = method; request.url = url; request.headers = { authorization: `Bearer ${token}` };
    return request;
  };
  const suspensionTargets = await listingsApi(apiRequest('GET', '/api/v1/suspensions/targets', 'synthetic-admin'));
  assert.equal(suspensionTargets.status, 200);
  assert.equal(suspensionTargets.body.targets.some(row => row.id === '22222222-2222-4222-8222-222222222222'), false,
    'suspension target directory never includes another school');
  assert.equal(suspensionTargets.body.targets.some(row => row.id === '33333333-3333-4333-8333-333333333333'), false,
    'administrator cannot suspend self');
  const suspensionIssue = await listingsApi(apiRequest('PATCH', '/api/v1/suspensions/11111111-1111-4111-8111-111111111111', 'synthetic-admin', {
    action: 'issue', duration_hours: 24, reason: 'Repeatedly disrupted the shared school board.',
  }));
  assert.equal(suspensionIssue.status, 201);
  assert.equal(suspensionIssue.body.suspension.target_role, 'student');
  const openSuspension = await sql`SELECT suspension_id FROM fam_account_suspension_open WHERE target_id = '11111111-1111-4111-8111-111111111111';`;
  assert.equal(openSuspension[0][0].suspension_id, suspensionIssue.body.suspension.suspension_id);
  assert.equal((await listingsApi(apiRequest('PATCH', '/api/v1/suspensions/11111111-1111-4111-8111-111111111111', 'synthetic-admin', {
    action: 'issue', duration_hours: 72, reason: 'Repeatedly disrupted the shared school board.',
  }))).status, 409, 'a second active restriction cannot be issued');
  const suspensionAudit = await sql`SELECT action, duration_hours FROM fam_account_suspension_audit WHERE target_id = '11111111-1111-4111-8111-111111111111';`;
  assert.equal(suspensionAudit[0].length, 1);
  assert.equal(suspensionAudit[0][0].action, 'issued');
  const suspensionLift = await listingsApi(apiRequest('PATCH', '/api/v1/suspensions/11111111-1111-4111-8111-111111111111', 'synthetic-admin', { action: 'lift' }));
  assert.equal(suspensionLift.status, 200);
  const liftedRecord = await sql`SELECT status, lifted_by FROM fam_account_suspensions WHERE suspension_id = ${suspensionIssue.body.suspension.suspension_id};`;
  assert.equal(liftedRecord[0][0].status, 'lifted');
  assert.equal(liftedRecord[0][0].lifted_by, '33333333-3333-4333-8333-333333333333');
  const clearedSuspension = await sql`SELECT suspension_id FROM fam_account_suspension_open WHERE target_id = '11111111-1111-4111-8111-111111111111';`;
  assert.equal(clearedSuspension[0].length, 0, 'lifting removes the open key atomically with the audit record');
  const finalSuspensionAudit = await sql`SELECT action FROM fam_account_suspension_audit WHERE target_id = '11111111-1111-4111-8111-111111111111' ORDER BY created_at ASC;`;
  assert.deepEqual(finalSuspensionAudit[0].map(row => row.action), ['issued', 'lifted']);
  const staleAdminAuth = await listingsApi(apiRequest('PATCH', '/api/v1/suspensions/11111111-1111-4111-8111-111111111111', 'synthetic-stale-admin', { action: 'lift' }));
  assert.equal(staleAdminAuth.status, 403);
  const roleTargets = await listingsApi(apiRequest('GET', '/api/v1/role-management/targets', 'synthetic-admin'));
  assert.equal(roleTargets.status, 200);
  assert.ok(roleTargets.body.targets.some(row => row.id === '77777777-7777-4777-8777-777777777777'));
  assert.ok(!roleTargets.body.targets.some(row => row.id === '33333333-3333-4333-8333-333333333333'), 'administrator cannot demote self');
  const revokeCouncilRole = await listingsApi(apiRequest('PATCH', '/api/v1/role-management/77777777-7777-4777-8777-777777777777', 'synthetic-admin', { action: 'revoke' }));
  assert.deepEqual(revokeCouncilRole, { status: 200, body: { ok: true, target_id: '77777777-7777-4777-8777-777777777777', previous_role: 'council_member', role: 'student' } });
  assert.equal((await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-role-target' })).role, 'student');
  const revokedAudit = await sql`SELECT action, previous_role FROM fam_school_admin_audit WHERE target_id = '77777777-7777-4777-8777-777777777777';`;
  assert.equal(revokedAudit[0][0].action, 'role_revoked');
  assert.equal(revokedAudit[0][0].previous_role, 'council_member');
  const revokeSecondAdmin = await listingsApi(apiRequest('PATCH', '/api/v1/role-management/88888888-8888-4888-8888-888888888888', 'synthetic-admin', { action: 'revoke' }));
  assert.deepEqual(revokeSecondAdmin, { status: 200, body: { ok: true, target_id: '88888888-8888-4888-8888-888888888888', previous_role: 'school_admin', role: 'student' } });
  assert.equal((await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-admin-target' })).role, 'student');
  const deniedStaleRevoke = await listingsApi(apiRequest('PATCH', '/api/v1/role-management/88888888-8888-4888-8888-888888888888', 'synthetic-stale-admin', { action: 'revoke' }));
  assert.equal(deniedStaleRevoke.status, 403, 'role revocation requires recent authentication');
  const otherSchoolRevoke = await listingsApi(apiRequest('PATCH', '/api/v1/role-management/44444444-4444-4444-8444-444444444444', 'synthetic-admin', { action: 'revoke' }));
  assert.equal(otherSchoolRevoke.status, 404, 'role revocation cannot cross school boundaries');
  const pulseAnnouncement = await listingsApi(apiRequest('POST', '/api/v1/pulse/announcements', 'synthetic-admin', {
    title: 'Проверка школьной доски', body: 'Встреча состоится в пятницу', kind: 'news', school_id: 'other-school', author_id: '22222222-2222-4222-8222-222222222222',
  }));
  assert.equal(pulseAnnouncement.status, 201, JSON.stringify(pulseAnnouncement.body));
  const pulsePoll = await listingsApi(apiRequest('POST', '/api/v1/pulse/polls', 'synthetic-council', {
    question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика'],
  }));
  assert.equal(pulsePoll.status, 201);
  const invalidPulsePoll = await listingsApi(apiRequest('POST', '/api/v1/pulse/polls', 'synthetic-council', {
    question: 'Какую книгу обсудим?', options: ['Сказки', ' сказки '],
  }));
  assert.equal(invalidPulsePoll.status, 400);
  const pulseRead = await listingsApi(apiRequest('GET', '/api/v1/pulse', 'synthetic-registrant'));
  assert.equal(pulseRead.status, 200);
  assert.ok(pulseRead.body.announcements.some(row => row.id === pulseAnnouncement.body.id));
  assert.equal(pulseRead.body.announcements[0].author_id, undefined, 'school pulse never exposes author identity');
  assert.ok(pulseRead.body.polls.some(row => row.id === pulsePoll.body.id));
  const pollVoters = ['synthetic-user', 'synthetic-registrant', 'synthetic-role-student', 'synthetic-admin', 'synthetic-council'];
  for (const [index, token] of pollVoters.entries()) {
    const vote = await listingsApi(apiRequest('POST', `/api/v1/pulse/polls/${pulsePoll.body.id}/votes`, token, { choice_index: index % 2 }));
    assert.equal(vote.status, 201);
  }
  const duplicatePollVote = await listingsApi(apiRequest('POST', `/api/v1/pulse/polls/${pulsePoll.body.id}/votes`, 'synthetic-registrant', { choice_index: 0 }));
  assert.equal(duplicatePollVote.status, 409);
  const otherSchoolPulse = await listingsApi(apiRequest('GET', '/api/v1/pulse', 'synthetic-other-school'));
  assert.equal(otherSchoolPulse.status, 200);
  assert.equal(otherSchoolPulse.body.announcements.length, 0, 'school pulse feed cannot cross school boundaries');
  const pulseAfterVotes = await listingsApi(apiRequest('GET', '/api/v1/pulse', 'synthetic-registrant'));
  const visiblePoll = pulseAfterVotes.body.polls.find(row => row.id === pulsePoll.body.id);
  assert.equal(visiblePoll.total_votes, 5);
  assert.deepEqual(visiblePoll.counts, [3, 2], 'choice totals appear only after five synthetic votes');
  assert.equal(visiblePoll.my_vote, 1);
  const deletionRequest = await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-council', {
    target_id: '11111111-1111-4111-8111-111111111111', reason_code: 'spam',
    reason: 'Repeated unrelated posts in the school group.',
  }));
  assert.equal(deletionRequest.status, 202);
  assert.equal(deletionRequest.body.already_exists, false);
  const duplicateDeletionRequest = await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-council', {
    target_id: '11111111-1111-4111-8111-111111111111', reason_code: 'spam',
    reason: 'Repeated unrelated posts in the school group.',
  }));
  assert.equal(duplicateDeletionRequest.status, 200);
  assert.equal(duplicateDeletionRequest.body.request_id, deletionRequest.body.request_id);
  const deletionQueue = await listingsApi(apiRequest('GET', '/api/v1/deletion-requests/review', 'synthetic-admin'));
  assert.equal(deletionQueue.status, 200);
  assert.equal(deletionQueue.body.requests.length, 1);
  assert.equal(Object.hasOwn(deletionQueue.body.requests[0], 'issuer'), false);
  const ownDeletionRequests = await listingsApi(apiRequest('GET', '/api/v1/deletion-requests', 'synthetic-council'));
  assert.equal(ownDeletionRequests.status, 200);
  assert.equal(ownDeletionRequests.body.requests.length, 1);
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/deletion-requests/review', 'synthetic-lyceum-admin'))).body.requests.length, 0,
    'the review queue is restricted to the administrator school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/deletion-requests/${deletionRequest.body.request_id}`, 'synthetic-admin', {
    decision: 'reject', review_note: 'Проверено в тестовой школе',
  })), { status: 200, body: { ok: true, status: 'rejected' } });
  const updatedOwnDeletionRequests = await listingsApi(apiRequest('GET', '/api/v1/deletion-requests', 'synthetic-council'));
  assert.equal(updatedOwnDeletionRequests.body.requests[0].status, 'rejected');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/deletion-requests/review', 'synthetic-admin'))).body.requests.length, 0);
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/deletion-requests/review', 'synthetic-registrant'))).status, 403);
  assert.equal((await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-registrant', {
    target_id: '11111111-1111-4111-8111-111111111111', reason_code: 'spam', reason: 'Repeated unrelated posts in group.',
  }))).status, 403);
  console.log('YDB_ACCOUNT_DELETION_REQUEST_PASS: council submission/history, school-scoped admin queue/rejection, duplicate guard, and role enforcement');
  const profileSubmission = await listingsApi(apiRequest('POST', '/api/v1/profile-requests', 'synthetic-new-student', {
    school_id: 'lyceum_3', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б', role: 'school_admin',
  }));
  assert.equal(profileSubmission.status, 202);
  assert.equal(profileSubmission.body.status, 'pending');
  const privateProfileStatus = await listingsApi(apiRequest('GET', '/api/v1/profile-requests', 'synthetic-new-student'));
  assert.equal(privateProfileStatus.status, 200);
  assert.equal(privateProfileStatus.body.request.status, 'pending');
  assert.deepEqual(Object.keys(privateProfileStatus.body.request).sort(), ['created_at', 'request_id', 'school_id', 'status']);
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new' }), null,
    'an access request alone never creates a profile');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-student'))).status, 403,
    'students cannot read access requests');
  const profileQueue = await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-lyceum-admin'));
  assert.equal(profileQueue.status, 200);
  const profileRequest = profileQueue.body.requests.find(row => row.first_name === 'Тест' && row.last_name === 'Профиль');
  assert.ok(profileRequest);
  assert.equal(Object.hasOwn(profileRequest, 'subject'), false, 'review queue omits external identity subjects');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${profileRequest.request_id}`, 'synthetic-admin', { decision: 'approve' }))).status, 404,
    'an administrator from another school cannot approve the request');
  const profileDecision = await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${profileRequest.request_id}`, 'synthetic-lyceum-admin', { decision: 'approve' }));
  assert.deepEqual(profileDecision, { status: 200, body: { ok: true, status: 'approved' } });
  const approvedActor = await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new' });
  assert.ok(approvedActor);
  assert.match(approvedActor.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ school_id: approvedActor.school_id, role: approvedActor.role, first_name: approvedActor.first_name,
    last_name: approvedActor.last_name, class_name: approvedActor.class_name }, {
    school_id: 'lyceum_3', role: 'student', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б',
  });
  const roleSubmission = await listingsApi(apiRequest('POST', '/api/v1/role-requests', 'synthetic-role-student', { requested_role: 'Участник Ученического совета' }));
  assert.equal(roleSubmission.status, 202, 'a verified student may request a fixed school role');
  const roleQueue = await listingsApi(apiRequest('GET', '/api/v1/role-requests/review', 'synthetic-admin'));
  assert.equal(roleQueue.status, 200);
  const roleRequest = roleQueue.body.requests.find(row => row.request_id === roleSubmission.body.request_id);
  assert.ok(roleRequest);
  assert.equal(roleRequest.requested_role, 'council_member');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/role-requests/${roleRequest.request_id}`, 'synthetic-lyceum-admin', { action: 'start_review' }))).status, 409,
    'a different school cannot claim the role request');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/role-requests/${roleRequest.request_id}`, 'synthetic-admin', { action: 'start_review' }))).status, 200);
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/role-requests/${roleRequest.request_id}`, 'synthetic-admin', { decision: 'approve' })),
    { status: 200, body: { ok: true, status: 'approved' } });
  const elevatedActor = await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-role-student' });
  assert.equal(elevatedActor.role, 'council_member', 'only the same-school administrator decision grants the role');
  const profileEdit = await listingsApi(apiRequest('PATCH', '/api/v1/me', 'synthetic-role-student', {
    first_name: 'Советник', last_name: 'Тестовый', class_name: '9Б', role: 'school_admin', school_id: 'other-school', user_id: 'forged-user',
  }));
  assert.equal(profileEdit.status, 200);
  assert.deepEqual({ role: profileEdit.body.profile.role, school_id: profileEdit.body.profile.school_id,
    first_name: profileEdit.body.profile.first_name, last_name: profileEdit.body.profile.last_name, class_name: profileEdit.body.profile.class_name }, {
    role: 'council_member', school_id: 'synthetic-school', first_name: 'Советник', last_name: 'Тестовый', class_name: '9Б',
  });
  const auditRows = await sql`SELECT action, status FROM fam_school_role_request_audit WHERE request_id = ${roleRequest.request_id};`;
  assert.equal(auditRows?.[0]?.length, 3, 'submission, review claim, and decision are retained in the audit table');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/profile-requests', 'synthetic-new-student'))).body.request.status, 'approved');
  const apiSubmission = await listingsApi(apiRequest('POST', '/api/v1/listings', 'synthetic-student', {
    title: 'Обмен учебниками', description: 'Синтетическое объявление для интеграционной проверки', category: 'Учёба',
  }));
  assert.equal(apiSubmission.status, 201);
  assert.equal(apiSubmission.body.status, 'pending');
  assert.deepEqual(await repo.listActiveListings(), [], 'API submissions remain invisible before school moderation');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/listings/${apiSubmission.body.id}/moderation`, 'synthetic-student', { decision: 'approve' }))).status, 403,
    'student cannot moderate even when using a valid database-backed identity');
  const apiApproval = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${apiSubmission.body.id}/moderation`, 'synthetic-admin', { decision: 'approve' }));
  assert.deepEqual(apiApproval, { status: 200, body: { ok: true, status: 'active' } });
  assert.equal((await repo.listActiveListings()).length, 1, 'approved API submission becomes visible through public projection');
  const title = "Синтетическая книга'); DELETE FROM fam_listings; --";
  const listing = await repo.createListing({ user_id: 'synthetic-user', school_id: 'synthetic-school', title,
    description: 'Учебник', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
    event_date: null, event_time: null, event_type: null, max_seats: 0, status: 'pending' });
  const sets = await sql`SELECT id, user_id, school_id, title, status FROM fam_listings WHERE id = ${listing.id};`;
  assert.equal(sets[0].length, 1);
  assert.equal(sets[0][0].title, title);
  assert.equal(sets[0][0].user_id, 'synthetic-user');
  assert.equal(sets[0][0].school_id, 'synthetic-school');
  assert.equal(sets[0][0].status, 'pending');
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, true), false, 'pending listings cannot be favorited');
  const beforeDirectModeration = await repo.listActiveListings();
  assert.equal(beforeDirectModeration.length, 1, 'only the separately API-approved item is public');
  assert.equal(beforeDirectModeration.some(row => row.id === listing.id), false, 'pending content must not appear publicly');
  assert.equal(await repo.moderateListing(listing.id, 'other-school', 'active'), false, 'other school cannot moderate');
  assert.equal(await repo.moderateListing(listing.id, 'synthetic-school', 'active'), true, 'school moderator can approve pending listing');
  const publicListings = await repo.listActiveListings();
  assert.equal(publicListings.length, 2);
  const publicDirectListing = publicListings.find(row => row.id === listing.id);
  assert.ok(publicDirectListing);
  assert.equal(await repo.getListingContactRecipient(listing.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school'), 'synthetic-user',
    'a same-school member can contact the owner of an active listing');
  assert.equal(await repo.getListingContactRecipient(listing.id, 'synthetic-user', 'synthetic-school'), null,
    'listing owners cannot open a self-conversation');
  assert.equal(await repo.getListingContactRecipient(listing.id, '11111111-1111-4111-8111-111111111111', 'other-school'), null,
    'listing contact lookup cannot cross school boundaries');
  assert.equal(publicDirectListing.title, title);
  assert.equal(Object.hasOwn(publicDirectListing, 'user_id'), false);
  assert.equal(Object.hasOwn(publicDirectListing, 'school_id'), false);
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, true), true);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), [listing.id]);
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, false), true);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), []);

  const deletionPhotoKey = 'pending/11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp';
  await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', deletionPhotoKey);
  const deletable = await repo.createListing({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school',
    title: 'Своё синтетическое объявление', description: 'Проверка удаления владельцем', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: deletionPhotoKey, photo_status: 'approved', status: 'pending' });
  assert.equal(await repo.moderateListing(deletable.id, 'synthetic-school', 'active'), true);
  assert.equal(await repo.setFavorite('synthetic-user', deletable.id, true), true);
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/me/listings', 'synthetic-registrant'))).body.listing_ids, [deletable.id],
    'private own-listing projection only returns the authenticated student’s active ids');
  assert.equal((await listingsApi(apiRequest('DELETE', `/api/v1/listings/${deletable.id}`, 'synthetic-student', null))).status, 404,
    'a different student cannot remove someone else’s listing');
  assert.equal((await listingsApi(apiRequest('DELETE', `/api/v1/listings/${deletable.id}`, 'synthetic-admin', null))).status, 403,
    'school staff cannot use the ordinary-student self-delete route');
  const ownDelete = await listingsApi(apiRequest('DELETE', `/api/v1/listings/${deletable.id}`, 'synthetic-registrant', null));
  assert.deepEqual(ownDelete, { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.deepEqual(deletedMediaKeys, [deletionPhotoKey]);
  assert.equal((await repo.listActiveListings()).some(row => row.id === deletable.id), false);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), []);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${deletionPhotoKey};`)?.[0]?.length ?? 0, 0,
    'deleted listing cleanup removes its media registry entry after the object store confirms deletion');
  const idea = await repo.createIdea({ user_id: 'synthetic-user', school_id: 'synthetic-school',
    text: 'Синтетическая идея книжного обмена', ai_status: 'pending', ai_summary: 'Синтетическая идея',
    ai_reason: 'review_unavailable', admin_status: 'new' });
  const ideaRows = await sql`SELECT user_id, school_id, text, ai_status, admin_status FROM fam_ideas WHERE id = ${idea.id};`;
  assert.equal(ideaRows[0][0].user_id, 'synthetic-user');
  assert.equal(ideaRows[0][0].school_id, 'synthetic-school');
  assert.equal(ideaRows[0][0].ai_status, 'pending');
  assert.equal(ideaRows[0][0].admin_status, 'new');
  const message = await repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school', body: 'Синтетическое одобренное сообщение' });
  const messageRows = await sql`SELECT sender_id, receiver_id, school_id, body, is_read FROM fam_messages WHERE id = ${message.id};`;
  assert.equal(messageRows[0][0].receiver_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(messageRows[0][0].school_id, 'synthetic-school');
  assert.equal(messageRows[0][0].is_read, false);
  assert.deepEqual((await repo.listMessages('synthetic-user', 'synthetic-school')).map(row => row.id), [message.id]);
  assert.deepEqual(await repo.listMessages('unrelated-user', 'synthetic-school'), []);
  assert.equal(await repo.markMessageRead('synthetic-user', 'synthetic-school', message.id), false, 'sender cannot mark the recipient inbox as read');
  assert.equal(await repo.markMessageRead('11111111-1111-4111-8111-111111111111', 'synthetic-school', message.id), true);
  const readRows = await sql`SELECT is_read FROM fam_messages WHERE id = ${message.id};`;
  assert.equal(readRows[0][0].is_read, true);
  await assert.rejects(repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '22222222-2222-4222-8222-222222222222', school_id: 'synthetic-school', body: 'cross-school synthetic' }), error => error.code === 'recipient_unavailable');

  const limitedEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическая встреча с ограниченным числом мест', description: 'Проверка атомарной записи', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-01', event_time: '12:00', event_type: 'limited', max_seats: 1, status: 'pending' });
  assert.equal(await repo.moderateListing(limitedEvent.id, 'synthetic-school', 'active'), true);
  const eventApiRequest = apiRequest('POST', `/api/v1/listings/${limitedEvent.id}/registrations`, 'synthetic-registrant', null);
  const registrationResponse = await listingsApi(eventApiRequest);
  assert.equal(registrationResponse.status, 201);
  assert.equal(registrationResponse.body.registration.status, 'confirmed');
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 1);
  await assert.rejects(repo.registerForEvent(limitedEvent.id, '22222222-2222-4222-8222-222222222222'), error => error.code === 'no_seats_available');
  assert.equal(await repo.cancelEventRegistration(limitedEvent.id, '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 0);
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/event-registrations', 'synthetic-registrant'))).body.registrations
    .filter(row => row.event_id === limitedEvent.id).map(row => row.status), ['cancelled']);

  const concurrentEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое мероприятие для гонки за местом', description: 'Параллельная проверка вместимости', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-03', event_time: '12:00', event_type: 'limited', max_seats: 1, status: 'pending' });
  assert.equal(await repo.moderateListing(concurrentEvent.id, 'synthetic-school', 'active'), true);
  const concurrentAttempts = await Promise.allSettled([
    repo.registerForEvent(concurrentEvent.id, '11111111-1111-4111-8111-111111111111'),
    repo.registerForEvent(concurrentEvent.id, '22222222-2222-4222-8222-222222222222'),
  ]);
  assert.equal(concurrentAttempts.filter(result => result.status === 'fulfilled').length, 1,
    'serializable capacity check permits at most one successful registration for the final seat');
  assert.equal(await repo.getEventOccupancy(concurrentEvent.id), 1, 'concurrent requests cannot overbook or lose the occupancy count');

  const reviewEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое мероприятие по заявкам', description: 'Проверка школьного решения', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-02', event_time: '12:00', event_type: 'request', max_seats: 0, status: 'pending' });
  assert.equal(await repo.moderateListing(reviewEvent.id, 'synthetic-school', 'active'), true);
  const requestResponse = await listingsApi(apiRequest('POST', `/api/v1/listings/${reviewEvent.id}/registrations`, 'synthetic-registrant', null));
  assert.equal(requestResponse.status, 201);
  assert.equal(requestResponse.body.registration.status, 'pending');
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 1);
  const reviewQueue = await listingsApi(apiRequest('GET', '/api/v1/event-registrations/review', 'synthetic-admin'));
  assert.equal(reviewQueue.status, 200);
  assert.equal(reviewQueue.body.applications.some(row => row.event_id === reviewEvent.id && row.user_id === '11111111-1111-4111-8111-111111111111'), true,
    'same-school moderator can see the synthetic pending registration');
  assert.equal(reviewQueue.body.applications.some(row => row.user_id === '22222222-2222-4222-8222-222222222222'), false,
    'event review queue excludes registrations from other schools');
  const studentReviewQueue = await listingsApi(apiRequest('GET', '/api/v1/event-registrations/review', 'synthetic-student'));
  assert.equal(studentReviewQueue.status, 403, 'students cannot read the event review queue');
  assert.equal(await repo.moderateEventRegistration(reviewEvent.id, '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'other-school', 'confirmed'), false,
    'event registration review is scoped to the event owner school');
  const reviewResponse = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${reviewEvent.id}/registrations/11111111-1111-4111-8111-111111111111`, 'synthetic-admin', { decision: 'reject' }));
  assert.deepEqual(reviewResponse, { status: 200, body: { ok: true, status: 'rejected' } });
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 0, 'rejecting a pending request releases its reserved seat');
  await sql`UPSERT INTO fam_account_suspensions
    (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at)
    VALUES ('synthetic-school', 'synthetic-user', 'synthetic-suspension', 'student', 24,
      'Synthetic integration suspension', 'active', 'synthetic-admin', CurrentUtcTimestamp(),
      Unwrap(CurrentUtcTimestamp() + Interval('PT24H')));`;
  const suspendedWrite = await listingsApi(apiRequest('POST', '/api/v1/listings', 'synthetic-user', {
    title: 'Не должно сохраниться', description: 'Synthetic suspension guard', category: 'Учёба',
  }));
  assert.equal(suspendedWrite.status, 403, 'active account suspension blocks authenticated writes');
  assert.equal(suspendedWrite.body.error, 'account_suspended');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/listings', 'synthetic-user'))).status, 200,
    'account suspension leaves read access available');
  assert.equal((await repo.getActiveAccountSuspension('synthetic-school', 'synthetic-user'))?.reason,
    'Synthetic integration suspension');
  const photoKey = 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  await repo.registerPendingImage('33333333-3333-4333-8333-333333333333', photoKey);
  const photoListing = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое объявление с фото', description: 'Изображение остаётся закрытым до отдельного одобрения', category: 'Творчество',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: photoKey,
    photo_status: 'pending', status: 'pending' });
  assert.equal(await repo.claimPendingImageDeletion('33333333-3333-4333-8333-333333333333', photoKey), null,
    'an uploaded image cannot be discarded after it is atomically linked to a listing');
  assert.equal(await repo.moderateListing(photoListing.id, 'synthetic-school', 'active'), false,
    'listing with pending photo cannot become public');
  assert.equal((await repo.listActiveListings()).some(row => row.id === photoListing.id), false,
    'pending photo listing remains absent from the public projection');
  const orphanKey = 'pending/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp';
  await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', orphanKey);
  await sql`UPDATE fam_pending_media SET created_at = Unwrap(CurrentUtcTimestamp() - Interval('P8D')) WHERE object_key = ${orphanKey};`;
  const expiredMediaClaims = await repo.claimExpiredPendingImages(10);
  assert.deepEqual(expiredMediaClaims.map(item => item.object_key), [orphanKey],
    'stale unlinked uploads are claimed while the image attached to a listing is preserved');
  assert.equal(await repo.finishPendingImageCleanup(orphanKey, expiredMediaClaims[0].claim_token, true), true);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${orphanKey};`)?.[0]?.length ?? 0, 0,
    'completed cleanup removes the private media registry row');
  const otherSchoolPending = await repo.createListing({ user_id: '22222222-2222-4222-8222-222222222222', school_id: 'other-school',
    title: 'Чужое школьное объявление', description: 'Не должно попасть в очередь', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, status: 'pending' });
  const moderationQueue = await listingsApi(apiRequest('GET', '/api/v1/listings/moderation', 'synthetic-admin'));
  assert.equal(moderationQueue.status, 200);
  assert.ok(moderationQueue.body.listings.some(row => row.id === photoListing.id), 'school queue includes its own pending photo listing');
  assert.ok(!moderationQueue.body.listings.some(row => row.id === otherSchoolPending.id), 'school queue excludes other-school listings');
  assert.equal(moderationQueue.body.listings.find(row => row.id === photoListing.id).photo_url, `/api/v1/listings/${photoListing.id}/photo`);
  const deletingUserId = '11111111-1111-4111-8111-111111111111';
  const deletingImageKey = `pending/${deletingUserId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`;
  accountMediaKeys.add(deletingImageKey);
  await repo.registerPendingImage(deletingUserId, deletingImageKey);
  const deletingListing = await repo.createListing({ user_id: deletingUserId, school_id: 'synthetic-school',
    title: 'Собственное объявление для удаления аккаунта', description: 'Удаление проверяется только на синтетической базе', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: deletingImageKey, photo_status: 'pending', status: 'pending' });
  const accountDeletion = await listingsApi(apiRequest('DELETE', '/api/v1/me/account', 'synthetic-recent-registrant', {
    confirmation: 'УДАЛИТЬ МОЙ АККАУНТ',
  }));
  assert.deepEqual(accountDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 1 } });
  assert.ok(deletedMediaKeys.includes(deletingImageKey), 'account deletion removes all private objects under its owner prefix');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-2' }), null,
    'account deletion removes the identity mapping after cleanup');
  assert.equal((await sql`SELECT id FROM fam_listings WHERE id = ${deletingListing.id};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${deletingImageKey};`)?.[0]?.length ?? 0, 0);
  const requestedTargetId = '99999999-9999-4999-8999-999999999999';
  const requestedImageKey = `pending/${requestedTargetId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp`;
  accountMediaKeys.add(requestedImageKey);
  await repo.registerPendingImage(requestedTargetId, requestedImageKey);
  const requestedDeletion = await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-council', {
    target_id: requestedTargetId, reason_code: 'spam', reason: 'Repeated unrelated messages in the synthetic school test.',
  }));
  assert.equal(requestedDeletion.status, 202);
  const approvedDeletion = await listingsApi(apiRequest('PATCH', `/api/v1/deletion-requests/${requestedDeletion.body.request_id}`, 'synthetic-admin', {
    decision: 'approve', confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА', review_note: 'Подтверждено синтетическим тестом',
  }));
  assert.deepEqual(approvedDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 1 } });
  assert.ok(deletedMediaKeys.includes(requestedImageKey), 'approved deletion removes private media for the requested synthetic account');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-delete-target' }), null,
    'approved deletion removes the requested profile identity mapping');
  const approvedRequest = await sql`SELECT status, reviewed_by, review_note FROM fam_account_deletion_requests WHERE request_id = ${requestedDeletion.body.request_id};`;
  assert.deepEqual(approvedRequest[0][0], { status: 'approved', reviewed_by: '33333333-3333-4333-8333-333333333333', review_note: 'Подтверждено синтетическим тестом' });
  assert.equal((await sql`SELECT request_id FROM fam_account_deletion_open WHERE target_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0,
    'approved deletion closes the unique open request while retaining the decision record');
  console.log('YDB_LOCAL_INTEGRATION_PASS: school profile and role requests, role revocation, school-scoped announcements/polls/voting, own-profile identity update, own-listing delete and cleanup, listings, favorites, ideas, messages, school-scoped photo/event queues, pending-media lifecycle, photo visibility gate, event capacity/cancellation/review on disposable local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
