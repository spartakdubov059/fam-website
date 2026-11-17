Warning: truncated output (original token count: 19315)
Total output lines: 812

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
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name)
    VALUES ('https://issuer.synthetic', 'subject-safety-actor', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'synthetic-school', 'student', true, 'Тест', 'Нарушитель', '8Б');`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null, person_type: 'student', staff_position: null, staff_verification_status: 'not_required' });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
  const authenticate = async req => ({ issuer: 'https://issuer.synthetic', subject: ['Bearer synthetic-registrant', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? 'subject-2'
      : req.headers.authorization === 'Bearer synthetic-admin' ? 'subject-admin'
        : req.headers.authorization === 'Bearer synthetic-role-student' ? 'subject-role-student'
        : req.headers.authorization === 'Bearer synthetic-council' ? 'subject-council'
        : req.headers.authorization === 'Bearer synthetic-new-student' ? 'subject-new'
          : req.headers.authorization === 'Bearer synthetic-new-staff' ? 'subject-new-staff'
          : req.headers.authorization === 'Bearer synthetic-other-school' ? 'subject-3'
          : req.headers.authorization === 'Bearer synthetic-lyceum-admin' ? 'subject-lyceum-admin'
            : req.headers.authorization === 'Bearer synthetic-safety-actor' ? 'subject-safety-actor' : 'subject-1',
    authenticated_at: ['Bearer synthetic-admin', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? Math.floor(Date.now() / 1000) : null });
  const deletedMediaKeys = [];
  const accountMediaKeys = new Set();
  const listingsApi = createSuspensionWriteGuard({ authenticate, resolveActor, repository: repo })(createListingsApi({
    authenticate,
    resolveActor,
    repository: repo,
    safetyKey: 'local-ci-only-synthetic-safety-key-over-32-bytes',
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
  const savedNotificationState = await listingsApi(apiRequest('POST', '/api/v1/notification-reads', 'synthetic-registrant', {
    notification_keys: ['release:synthetic', 'dismissed:school-listing:synthetic-id'],
  }));
  assert.deepEqual(savedNotificationState, { status: 200, body: { ok: true } });
  const ownNotificationState = await listingsApi(apiRequest('GET', '/api/v1/notification-reads', 'synthetic-registrant'));
  assert.deepEqual(new Set(ownNotificationState.body.notification_keys), new Set(['release:synthetic', 'dismissed:school-listing:synthetic-id']));
  const isolatedNotificationState = await listingsApi(apiRequest('GET', '/api/v1/notification-reads', 'synthetic-other-school'));
  assert.deepEqual(isolatedNotificationState.body.notification_keys, [], 'notification read state is isolated by authenticated account');
  const agentMetrics = await repo.getSchoolAgentMetrics('synthetic-school');
  assert.ok(Number.isInteger(agentMetrics.listings.active));
  const globalAgentMetrics = await repo.getGlobalAgentDailyMetrics();
  assert.ok(Number.isInteger(globalAgentMetrics.listings.active));
  assert.ok(Number.isInteger(globalAgentMetrics.safety.unreviewed));
  assert.ok(Number.isInteger(globalAgentMetrics.ideas.pending));
  await repo.saveGlobalAgentDailyReport({ date: '2026-11-14',
    summary: 'Синтетическая внутренняя сводка', metrics: globalAgentMetrics });
  const savedGlobalAgentReport = await sql`SELECT report_date, summary, metrics_json FROM fam_agent_daily_reports WHERE report_date = '2026-11-14';`;
  assert.equal(savedGlobalAgentReport?.[0]?.[0]?.summary, 'Синтетическая внутренняя сводка');
  assert.deepEqual(JSON.parse(savedGlobalAgentReport[0][0].metrics_json), globalAgentMetrics);
  const digestDate = new Date().toISOString().slice(0, 10);
  assert.deepEqual(await repo.enqueueAgentDailyDigestTask(digestDate), { created: true, status: 'queued' });
  assert.deepEqual(await repo.enqueueAgentDailyDigestTask(digestDate), { created: false, status: 'queued' },
    'one durable aggregate digest task is created per UTC date');
  const digestClaim = await repo.claimAgentDailyDigestTask('synthetic-digest-worker', digestDate);
  assert.equal(digestClaim?.report_date, digestDate);
  assert.match(digestClaim?.claim_token ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(await repo.claimAgentDailyDigestTask('second-synthetic-worker', digestDate), null,
    'a live lease prevents a second worker from claiming the task');
  const digestMetrics = await repo.getAgentDailyDigestMetrics();
  assert.deepEqual(Object.keys(digestMetrics).sort(), ['active_listings', 'blocked_tasks_24h', 'completed_tasks_24h',
    'failed_tasks_24h', 'new_listings_24h', 'pending_ideas', 'queued_tasks'].sort());
  assert.ok(Object.values(digestMetrics).every(Number.isSafeInteger));
  assert.equal(await repo.completeAgentDailyDigestTask({ reportDate: digestDate, claimToken: digestClaim.claim_token,
    metrics: digestMetrics, summary: 'Синтетический агрегированный digest.' }), true);
  assert.equal(await repo.completeAgentDailyDigestTask({ reportDate: digestDate, claimToken: digestClaim.claim_token,
    metrics: digestMetrics, summary: 'Повторное завершение запрещено.' }), false,
  'a completed task cannot be completed again with a stale lease token');
  const savedDigest = await sql`SELECT status, metrics_json, summary FROM fam_agent_daily_digest_tasks WHERE report_date = ${digestDate};`;
  assert.equal(savedDigest?.[0]?.[0]?.status, 'completed');
  assert.deepEqual(J…14815 tokens truncated… status FROM fam_pending_media WHERE object_key = ${rejectedTextImageKey};`)[0][0].status, 'pending',
    'text rejection safely releases its photo to the bounded orphan cleanup queue');
  const deletingListing = await repo.createListing({ user_id: deletingUserId, school_id: 'synthetic-school',
    title: 'Собственное объявление для удаления аккаунта', description: 'Удаление проверяется только на синтетической базе', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: deletingImageKey, photo_status: 'pending', status: 'pending' });
  const accountDeletion = await listingsApi(apiRequest('DELETE', '/api/v1/me/account', 'synthetic-recent-registrant', {
    confirmation: 'УДАЛИТЬ МОЙ АККАУНТ',
  }));
  assert.deepEqual(accountDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 3 } });
  assert.ok(deletedMediaKeys.includes(deletingImageKey), 'account deletion removes all private objects under its owner prefix');
  assert.ok(deletedMediaKeys.includes(attachedIdeaImageKey), 'account deletion removes linked idea photos');
  assert.ok(deletedMediaKeys.includes(rejectedIdeaImageKey), 'account deletion removes rejected idea photos awaiting orphan cleanup');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-2' }), null,
    'account deletion removes the identity mapping after cleanup');
  assert.equal((await sql`SELECT id FROM fam_listings WHERE id = ${deletingListing.id};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${deletingImageKey};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT idea_id FROM fam_idea_images WHERE user_id = ${deletingUserId};`)?.[0]?.length ?? 0, 0,
    'account deletion removes private idea image references');
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
  const adminDeleteTargetId = '77777777-7777-4777-8777-777777777777';
  const adminDeleteImageKey = `pending/${adminDeleteTargetId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.webp`;
  accountMediaKeys.add(adminDeleteImageKey);
  await repo.registerPendingImage(adminDeleteTargetId, adminDeleteImageKey);
  const adminDeleteListing = await repo.createListing({ user_id: adminDeleteTargetId, school_id: 'synthetic-school',
    title: 'Объявление аккаунта для административного удаления', description: 'Синтетическая YDB проверка', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: adminDeleteImageKey, photo_status: 'pending', status: 'pending' });
  const adminDeletion = await listingsApi(apiRequest('DELETE', `/api/v1/school/accounts/${adminDeleteTargetId}`, 'synthetic-admin', {
    confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА',
  }));
  assert.deepEqual(adminDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 1 } });
  assert.ok(deletedMediaKeys.includes(adminDeleteImageKey), 'direct school-admin deletion removes the eligible synthetic target private image');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-role-target' }), null,
    'direct school-admin deletion removes only the same-school student identity mapping');
  assert.equal((await sql`SELECT id FROM fam_listings WHERE id = ${adminDeleteListing.id};`)?.[0]?.length ?? 0, 0);
  const adminDeleteAudit = await sql`SELECT action, previous_role FROM fam_school_admin_audit WHERE target_id = ${adminDeleteTargetId};`;
  assert.deepEqual(adminDeleteAudit[0], [{ action: 'account_deleted', previous_role: 'student' }],
    'administrator deletion is preserved in the audit after the profile is removed');
  const quotaUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  const quotaListing = { user_id: quotaUserId, school_id: 'synthetic-school', title: 'Синтетическое объявление',
    description: 'Проверка ограничения количества', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
    max_seats: 0, status: 'pending' };
  for (let i = 0; i < 5; i++) await repo.createListing(quotaListing);
  const listingQuotaState = await sql`SELECT action, submission_count, window_start FROM fam_submission_quotas WHERE user_id = ${quotaUserId};`;
  assert.equal(Number(listingQuotaState[0].find(row => row.action === 'listing')?.submission_count), 5,
    'the serializable counter records the five allowed listings');
  assert.deepEqual(await repo.createListing(quotaListing), { ok: false, code: 'rate_limited' },
    'the sixth listing in one hour is rejected for this synthetic account');
  const quotaIdea = { user_id: quotaUserId, school_id: 'synthetic-school', text: 'Синтетическая идея',
    ai_status: 'pending', ai_summary: 'Идея', ai_reason: 'review_unavailable', admin_status: 'new' };
  for (let i = 0; i < 10; i++) await repo.createIdea(quotaIdea);
  assert.deepEqual(await repo.createIdea(quotaIdea), { ok: false, code: 'rate_limited' },
    'the eleventh idea in one hour is rejected for this synthetic account');
  for (let i = 0; i < 5; i++) await repo.reserveImageUpload(quotaUserId);
  assert.equal(await repo.reserveImageUpload(quotaUserId), false,
    'a sixth image decode reservation in one hour is rejected for this synthetic account');
  const quotaRows = await sql`SELECT action, submission_count FROM fam_submission_quotas WHERE user_id = ${quotaUserId};`;
  assert.deepEqual(Object.fromEntries(quotaRows[0].map(row => [row.action, Number(row.submission_count)])), { idea: 10, image_upload: 5, listing: 5 });
  const indexProbes = await Promise.all([
    sql`SELECT id FROM fam_avatar_reviews VIEW fam_avatar_reviews_user_id_idx WHERE user_id = ${quotaUserId};`,
    sql`SELECT announcement_id FROM fam_school_announcements VIEW fam_school_announcements_author_id_idx WHERE author_id = ${quotaUserId};`,
    sql`SELECT poll_id FROM fam_school_polls VIEW fam_school_polls_author_id_idx WHERE author_id = ${quotaUserId};`,
    sql`SELECT choice_index FROM fam_school_poll_votes VIEW fam_school_poll_votes_voter_id_idx WHERE voter_id = ${quotaUserId};`,
  ]);
  assert.ok(indexProbes.every(rows => (rows?.[0]?.length ?? 0) === 0), 'all four FK lookup indexes are usable on the empty synthetic tables');
  console.log('YDB_LOCAL_INTEGRATION_PASS: school profile/role/deletion requests, same-school account and listing deletion, school content/polls, own-profile identity, private media cleanup, manual school-scoped avatar review and approval, aggregate agent reports and school-bound idea review, allowlisted hourly error telemetry, persistent hourly listing/idea/image-upload quotas, four secondary lookup indexes, listings, favorites, ideas, messages, events, all on disposable synthetic local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
