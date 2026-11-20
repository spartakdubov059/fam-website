Warning: truncated output (original token count: 21091)
Total output lines: 881

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createYdbAgentTaskQueue } from '../app/backend/repositories/ydb-agent-task-queue.mjs';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
import { createSuspensionWriteGuard } from '../app/backend/auth/suspension-write-guard.mjs';
import { createListingsApi } from '../app/backend/services/listings-api.mjs';
import { createAccountDeletionRecoveryOperation } from '../app/backend/services/recover-account-deletions.mjs';

// This script is intentionally hard-wired to the disposable local database.
const driver = new Driver('grpc://127.0.0.1:2136/local');
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => { const statement = client(strings, ...values); statement.on('error', () => {}); return statement; };
  sql.begin = client.begin.bind(client);
  const repo = createYdbListingsRepository(sql);
  const beginAccountDeletion = repo.beginAccountDeletion.bind(repo);
  repo.beginAccountDeletion = async input => {
    try {
      const result = await beginAccountDeletion(input);
      console.error('YDB_SYNTHETIC_ACCOUNT_DELETION_BEGIN_RESULT:', JSON.stringify({ ok: result?.ok, code: result?.code, hasClaimToken: Boolean(result?.claim_token) }));
      return result;
    } catch (error) {
      console.error('YDB_SYNTHETIC_ACCOUNT_DELETION_BEGIN_ERROR:', error?.message || 'unknown');
      throw error;
    }
  };
  const finishAccountDeletion = repo.finishAccountDeletion.bind(repo);
  repo.finishAccountDeletion = async input => {
    try {
      const result = await finishAccountDeletion(input);
      if (!result?.ok) console.error('YDB_SYNTHETIC_ACCOUNT_DELETION_FINALIZE_REJECTED:', result?.code || 'unknown');
      return result;
    } catch (error) {
      console.error('YDB_SYNTHETIC_ACCOUNT_DELETION_FINALIZE_ERROR:', error?.message || 'unknown');
      throw error;
    }
  };
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
    ('https://issuer.synthetic', 'subject-recovery', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'synthetic-school', 'student', true),
    ('https://issuer.synthetic', 'subject-lyceum-admin', '44444444-4444-4444-8444-444444444444', 'lyceum_3', 'school_admin', true);`;
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name)    VALUES ('https://issuer.synthetic', 'subject-safety-actor', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'synthetic-school', 'student', true, 'Тест', 'Нарушитель', '8Б');`;
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
    return request;  };
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
  const digestMetrics = await repo.getAgentDailyDigestMetrics();  assert.deepEqual(Object.keys(digestMetrics).sort(), ['active_listings', 'blocked_tasks_24h', 'completed_tasks_24h',
    'failed_tasks_24h', 'new_listings_24h', 'pending_ideas', 'queued_tasks'].sort());
  assert.ok(Object.values(digestMetrics).every(Number.isSafeInteger));
  assert.equal(await repo.completeAgentDailyDigestTask({ reportDate: digestDate, claimToken: digestClaim.claim_token,
    metrics: digestMetrics, summary: 'Синтетический агрегированный digest.' }), true);
  assert.equal(await repo.completeAgentDailyDigestTask({ reportDate: digestDate, claimToken: digestClaim.claim_token,
    metrics: digestMetrics, summary: 'Повторное завершение запрещено.' }), false,
  'a completed task cannot be completed again with a stale lease token');
  const savedDigest = await sql`SELECT status, metrics_json, summary FROM fam_agent_daily_digest_tasks WHERE report_date = ${digestDate};`;
  assert.equal(savedDigest?.[0]?.[0]?.status, 'completed');
  assert.deepEqual(JSON.parse(savedDigest[0][0].metrics_json), digestMetrics);
  assert.equal(savedDigest[0][0].summary, 'Синтетический агрегированный digest.');
  assert.equal(await repo.recordSiteError({ eventCode: 'js_runtime', pageArea: 'other', occurredAt: new Date('2026-11-14T12:34:00.000Z') }), 1);
  assert.equal(await repo.recordSiteError({ eventCode: 'js_runtime', pageArea: 'other', occurredAt: new Date('2026-11-14T12:59:00.000Z') }), 2);
  assert.equal(await repo.recordSiteError({ eventCode: 'js_runtime', pageArea: 'other', occurredAt: new Date('2026-11-14T13:00:00.000Z') }), 1);
  const siteErrorBuckets = await sql`SELECT hour_bucket, event_code, page_area, event_count FROM fam_site_error_counts WHERE event_code = 'js_runtime' AND page_area = 'other' ORDER BY hour_bucket ASC;`;
  assert.deepEqual(siteErrorBuckets?.[0] ?? [], [
    { hour_bucket: new Date('2026-11-14T12:00:00.000Z'), event_code: 'js_runtime', page_area: 'other', event_count: 2 },
    { hour_bucket: new Date('2026-11-14T13:00:00.000Z'), event_code: 'js_runtime', page_area: 'other', event_count: 1 },
  ]);
  const alertBucket = new Date();
  alertBucket.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const occurredAt = new Date(alertBucket.getTime() + i * 60_000);
    await repo.recordSiteError({ eventCode: 'database_request_failed', pageArea: 'database', occurredAt });
  }
  for (let i = 0; i < 10; i++) {
    const occurredAt = new Date(alertBucket.getTime() + i * 60_000);
    await repo.recordSiteError({ eventCode: 'unhandled_rejection', pageArea: 'other', occurredAt });
  }  const technicalAlerts = await repo.listSiteErrorAlerts();
  assert.deepEqual(technicalAlerts, [
    { hour_bucket: alertBucket, event_code: 'unhandled_rejection', page_area: 'other', event_count: 10, severity: 'warning' },
    { hour_bucket: alertBucket, event_code: 'database_request_failed', page_area: 'database', event_count: 3, severity: 'critical' },
  ]);
  const digestSlot = new Date(); digestSlot.setUTCMinutes(Math.floor(digestSlot.getUTCMinutes() / 15) * 15, 0, 0);
  const digestSlotKey = digestSlot.toISOString().slice(0, 16);
  assert.deepEqual(await repo.enqueueSiteErrorDigestTask(digestSlotKey), { created: true, status: 'queued' });
  assert.deepEqual(await repo.enqueueSiteErrorDigestTask(digestSlotKey), { created: false, status: 'queued' },
    'only one aggregate site error digest task is queued per UTC quarter-hour');
  const siteErrorClaim = await repo.claimSiteErrorDigestTask('synthetic-site-error-worker');
  assert.equal(siteErrorClaim.digest_slot, digestSlotKey);
  assert.match(siteErrorClaim.claim_token, /^[0-9a-f-]{36}$/i);
  assert.equal(await repo.claimSiteErrorDigestTask('second-site-error-worker'), null,
    'a live lease prevents another worker from claiming the digest');
  const siteErrorMetrics = await repo.getSiteErrorDigestMetrics();
  assert.equal(siteErrorMetrics.total_events_24h, 13);
  assert.equal(siteErrorMetrics.events_last_hour, 13);
  assert.deepEqual(siteErrorMetrics.events, [
    { event_code: 'unhandled_rejection', page_area: 'other', occurrences: 10 },
    { event_code: 'database_request_failed', page_area: 'database', occurrences: 3 },
  ]);
  assert.equal(await repo.completeSiteErrorDigestTask({ digestSlot: digestSlotKey, claimToken: siteErrorClaim.claim_token,
    metrics: siteErrorMetrics, summary: 'Синтетическая агрегированная сводка ошибок.' }), true);
  assert.equal(await repo.completeSiteErrorDigestTask({ digestSlot: digestSlotKey, claimToken: siteErrorClaim.claim_token,
    metrics: siteErrorMetrics, summary: 'Повторная запись запрещена.' }), false, 'a completed task rejects a stale lease token');
  const savedSiteErrorDigest = await sql`SELECT status, metrics_json, summary FROM fam_site_error_digest_tasks WHERE digest_slot = ${digestSlotKey};`;
  assert.equal(savedSiteErrorDigest?.[0]?.[0]?.status, 'completed');
  assert.deepEqual(JSON.parse(savedSiteErrorDigest[0][0].metrics_json), siteErrorMetrics);
  assert.doesNotMatch(savedSiteErrorDigest[0][0].summary, /student|user_id|https?:|stack|телефон|почта/i);
  const backgroundQueueHealth = await repo.getRuBackgroundQueueHealth();
  assert.equal(backgroundQueueHealth.content_read, false);
  assert.equal(backgroundQueueHealth.queues.daily_reports.statuses.completed, 1);
  assert.equal(backgroundQueueHealth.queues.site_error_digests.statuses.completed, 1);
  assert.equal(backgroundQueueHealth.queues.daily_reports.expired_leases, 0);
  assert.equal(backgroundQueueHealth.queues.site_error_digests.expired_leases, 0);  await repo.saveSchoolAgentReport({ schoolId: 'synthetic-school', date: '2026-11-14',
    summary: 'Синтетическая сводка без пользовательских данных', metrics: agentMetrics });
  const syntheticIdeaId = 'a'.repeat(64);
  const insertedSyntheticAgentIdea = await repo.createSchoolAgentIdea({ id: syntheticIdeaId, schoolId: 'synthetic-school', date: '2026-11-14', count: 1,
    rule: { key: 'integration_review', title: 'Проверить синтетический сигнал', summary: () => 'Только синтетическая проверка.',
      benefit: 'Проверка YDB.', evidence: () => 'Синтетическая агрегированная запись.', proposedBy: 'integration_test' } });
  assert.equal(insertedSyntheticAgentIdea, true);
  assert.equal(await repo.createSchoolAgentIdea({ id: syntheticIdeaId, schoolId: 'synthetic-school', date: '2026-11-14', count: 1,
    rule: { key: 'integration_review', title: 'Проверить синтетический сигнал', summary: () => 'Повтор не должен создавать дубль.',
      benefit: 'Проверка YDB.', evidence: () => 'Синтетическая агрегированная запись.', proposedBy: 'integration_test' } }), false,
  'daily reruns must not duplicate a same-school same-day rule proposal');
  const agentDashboard = await listingsApi(apiRequest('GET', '/api/v1/school/admin/agent-dashboard', 'synthetic-admin'));
  assert.equal(agentDashboard.status, 200);
  assert.equal(agentDashboard.body.report.summary, 'Синтетическая сводка без пользовательских данных');
  assert.ok(agentDashboard.body.ideas.some(idea => idea.id === syntheticIdeaId));
  const otherSchoolAgentDashboard = await listingsApi(apiRequest('GET', '/api/v1/school/admin/agent-dashboard', 'synthetic-lyceum-admin'));
  assert.equal(otherSchoolAgentDashboard.status, 200);
  assert.equal(otherSchoolAgentDashboard.body.ideas.some(idea => idea.id === syntheticIdeaId), false);
  const reviewedAgentIdea = await listingsApi(apiRequest('PATCH', `/api/v1/school/admin/agent-ideas/${syntheticIdeaId}`, 'synthetic-admin', { decision: 'approve' }));
  assert.deepEqual(reviewedAgentIdea, { status: 200, body: { ok: true, status: 'approved' } });
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/school/admin/agent-ideas/${syntheticIdeaId}`, 'synthetic-admin', { decision: 'reject' }))).status, 409);
  const suspensionTargets = await listingsApi(apiRequest('GET', '/api/v1/suspensions/targets', 'synthetic-admin'));
  assert.equal(suspensionTargets.status, 200);
  assert.equal(suspensionTargets.body.targets.some(row => row.id === '22222222-2222-4222-8222-222222222222'), false,
    'suspension target directory never includes another school');
  assert.equal(suspensionTargets.body.targets.some(row => row.id === '33333333-3333-4333-8333-333333333333'), false,
    'administrator cannot suspend self');
  const suspensionIssue = await listingsApi(apiRequest('PATCH', '/api/v1/suspensions/11111111-1111-4111-8111-111111111111', 'synthetic-admin', {
    action: 'issue', duration_hours: 24, reason: 'Repeatedly disrupted the shared school board.',
  }));  assert.equal(suspensionIssue.status, 201);
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
  const finalSuspensionAudit = await sql`SELECT action FROM fam_…11091 tokens truncated… === 'threat_or_intimidation'));
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-lyceum-admin'))).body.reports.length, 0,
    'safety reports are isolated by school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', '/api/v1/school/admin/safety-reports', 'synthetic-admin', {    fingerprint: safetyFingerprint, category: 'targeted_harassment', source_kind: 'message',
  })), { status: 200, body: { ok: true } });
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-admin'))).body.reports.some(row => row.fingerprint === safetyFingerprint), false,
    'acknowledged safety clusters leave the unreviewed queue');
  const adminIdeaImageKey = 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-0000-4000-8000-000000000001.webp';
  await repo.registerPendingImage('33333333-3333-4333-8333-333333333333', adminIdeaImageKey);
  const adminOwnIdea = await repo.createIdea({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    text: 'Идея администратора для самопроверки', image_keys: [adminIdeaImageKey], image_status: 'pending',
    ai_status: 'approved', admin_status: 'new' });
  assert.equal((await repo.listPendingSchoolIdeas('synthetic-school', '33333333-3333-4333-8333-333333333333'))
    .some(idea => idea.id === adminOwnIdea.id), false, 'review queue omits the reviewer own submission');
  assert.equal(await repo.reviewSchoolIdeaImages({ ideaId: adminOwnIdea.id, schoolId: 'synthetic-school',
    reviewerId: '33333333-3333-4333-8333-333333333333', decision: 'approve' }), false,
  'school staff cannot approve their own idea photo');
  const deletingUserId = '11111111-1111-4111-8111-111111111111';
  const deletingImageKey = `pending/${deletingUserId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`;
  const attachedIdeaImageKey = `pending/${deletingUserId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp`;
  const rejectedIdeaImageKey = `pending/${deletingUserId}/ffffffff-ffff-4fff-8fff-ffffffffffff.webp`;
  accountMediaKeys.add(deletingImageKey);
  await repo.registerPendingImage(deletingUserId, deletingImageKey);
  accountMediaKeys.add(attachedIdeaImageKey);
  await repo.registerPendingImage(deletingUserId, attachedIdeaImageKey);
  const ideaSubmission = await listingsApi(apiRequest('POST', '/api/v1/ideas', 'synthetic-registrant', {
    text: 'Добавить синтетическую книжную полку в школьную библиотеку', image_keys: [attachedIdeaImageKey],
  }));
  assert.equal(ideaSubmission.status, 201);
  assert.equal(ideaSubmission.body.image_status, 'pending');
  const ideaQueue = await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-admin'));
  const submittedIdea = ideaQueue.body.ideas.find(idea => idea.id === ideaSubmission.body.id);
  assert.equal(submittedIdea.image_status, 'pending');  assert.deepEqual(submittedIdea.image_keys, [attachedIdeaImageKey]);
  assert.equal(Object.hasOwn(submittedIdea, 'user_id'), false, 'school review queue omits the submitter identity');
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-lyceum-admin'))).body.ideas, [],
    'school idea queue is isolated by school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${ideaSubmission.body.id}/images`, 'synthetic-admin', { decision: 'approve' })),
    { status: 200, body: { ok: true, image_status: 'approved' } });
  assert.equal((await repo.getSchoolIdeaImage(ideaSubmission.body.id, 0)).image_status, 'approved');
  accountMediaKeys.add(rejectedIdeaImageKey);
  await repo.registerPendingImage(deletingUserId, rejectedIdeaImageKey);
  const rejectedIdea = await listingsApi(apiRequest('POST', '/api/v1/ideas', 'synthetic-registrant', {
    text: 'Проверка безопасного отклонения фото', image_keys: [rejectedIdeaImageKey],
  }));
  assert.equal(rejectedIdea.status, 201);
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${rejectedIdea.body.id}/images`, 'synthetic-admin', { decision: 'reject' })),
    { status: 200, body: { ok: true, image_status: 'rejected' } });
  const rejectedIdeaRow = await sql`SELECT image_status FROM fam_ideas WHERE id = ${rejectedIdea.body.id};`;
  assert.deepEqual(rejectedIdeaRow[0][0], { image_status: 'rejected' });
  assert.deepEqual(await repo.listPendingSchoolIdeas('synthetic-school', '66666666-6666-4666-8666-666666666666')
    .then(rows => rows.find(row => row.id === rejectedIdea.body.id)?.image_keys), []);
  assert.equal(await repo.getSchoolIdeaImage(rejectedIdea.body.id, 0), null,
    'rejected school idea image is no longer readable');
  assert.equal((await sql`SELECT status FROM fam_pending_media WHERE object_key = ${rejectedIdeaImageKey};`)[0][0].status, 'pending',
    'rejected school idea image returns to the bounded orphan cleanup queue');
  const rejectedTextImageKey = `pending/${deletingUserId}/12345678-1234-4234-8234-123456789012.webp`;
  await repo.registerPendingImage(deletingUserId, rejectedTextImageKey);
  const rejectedTextIdea = await repo.createIdea({ user_id: deletingUserId, school_id: 'synthetic-school',
    text: 'Идея отклоняется модератором школы', image_keys: [rejectedTextImageKey], image_status: 'pending',
    ai_status: 'pending', admin_status: 'new' });
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${rejectedTextIdea.id}/moderation`, 'synthetic-admin', { decision: 'reject' })),
    { status: 200, body: { ok: true, ai_status: 'rejected' } });  assert.equal((await repo.listPendingSchoolIdeas('synthetic-school', '66666666-6666-4666-8666-666666666666'))
    .some(row => row.id === rejectedTextIdea.id), false, 'rejected idea text leaves the school review queue');
  assert.equal(await repo.getSchoolIdeaImage(rejectedTextIdea.id, 0), null, 'text rejection prevents reading its attached photo');
  assert.equal((await sql`SELECT status FROM fam_pending_media WHERE object_key = ${rejectedTextImageKey};`)[0][0].status, 'pending',
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
  const approvedDeletion = await listingsApi(apiRequest('PATCH', `/api/v1/deletion-requests/${requestedDeletion.body.request_id}`, 'synthetic-admin', {    decision: 'approve', confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА', review_note: 'Подтверждено синтетическим тестом',
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
  const recoveryUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
  const recoveryImageKey = `pending/${recoveryUserId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`;
  accountMediaKeys.add(recoveryImageKey);
  await repo.registerPendingImage(recoveryUserId, recoveryImageKey);
  const startedRecovery = await repo.beginAccountDeletion({ issuer: 'https://issuer.synthetic', subject: 'subject-recovery', userId: recoveryUserId });
  assert.equal(startedRecovery.ok, true);
  await sql`UPDATE fam_account_deletion_jobs SET claim_until = Unwrap(CurrentUtcTimestamp() - Interval('PT1M')) WHERE user_id = ${recoveryUserId};`;
  const recoverAccountDeletions = createAccountDeletionRecoveryOperation({ repository: repo, pendingImages: {
    listUserObjects: async userId => [...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)),
    delete: async key => { deletedMediaKeys.push(key); accountMediaKeys.delete(key); },
  } });
  assert.deepEqual(await recoverAccountDeletions(10), { claimed: 1, completed: 1, failed: 0 },
    'a durable account deletion job can be resumed after its lease expires');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-recovery' }), null,
    'manual recovery removes the synthetic account identity after deleting private media');
  assert.equal((await sql`SELECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${recoveryUserId};`)?.[0]?.length ?? 0, 0);
  const quotaUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  const quotaListing = { user_id: quotaUserId, school_id: 'synthetic-school', title: 'Синтетическое объявление',    description: 'Проверка ограничения количества', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
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
  const agentQueue = createYdbAgentTaskQueue(sql);
  const coderBucket = new Date();
  coderBucket.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 3; i++) {
    await repo.recordSiteError({ eventCode: 'js_runtime', pageArea: 'auth', occurredAt: new Date(coderBucket.getTime() + i * 60_000) });
  }
  const coderSlotDate = new Date();
  coderSlotDate.setUTCMinutes(Math.floor(coderSlotDate.getUTCMinutes() / 15) * 15, 0, 0);
  const coderSlot = coderSlotDate.toISOString().slice(0, 16);
  const coderTask = await agentQueue.enqueueSafeCoderTask(coderSlot);
  assert.equal(coderTask.created, true, 'thresholded aggregate telemetry creates a synthetic manual-review task');
  assert.equal(coderTask.task_key, 'audit_frontend_runtime');
  assert.equal((await agentQueue.enqueueSafeCoderTask(coderSlot)).created, false, 'coder task enqueue is idempotent per quarter-hour slot');
  const claimedBeforeCoder = await agentQueue.claimSafeTasks(5);
  assert.equal(claimedBeforeCoder.some(task => task.task_type === 'coder_patch_request'), false,
    'the automated worker allowlist never claims coder tasks');
  const queuedCoder = await sql`SELECT status, payload_json FROM fam_agent_tasks WHERE id = ${coderTask.id};`;
  assert.deepEqual(queuedCoder?.[0]?.[0], { status: 'queued', payload_json: '{}' },
    'coder task remains queued for manual review and carries no event payload');
  const safeTask = await agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:00');
  assert.equal(safeTask.created, true);
  assert.equal((await agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:00')).created, false,
    'safe scheduled task enqueue is idempotent');
  const claimedSafeTasks = await agentQueue.claimSafeTasks(1);
  assert.equal(claimedSafeTasks.length, 1);
  assert.equal(claimedSafeTasks[0].task_type, 'queue_health_check');
  assert.equal(Object.hasOwn(claimedSafeTasks[0], 'payload'), false, 'worker claim does not expose arbitrary task payload');
  assert.equal(await agentQueue.finishSafeTask({ id: claimedSafeTasks[0].id, claimToken: claimedSafeTasks[0].claim_token,
    status: 'completed', summary: 'Synthetic aggregate queue check completed.' }), true);
  assert.equal(await agentQueue.finishSafeTask({ id: claimedSafeTasks[0].id, claimToken: claimedSafeTasks[0].claim_token,
    status: 'completed', summary: 'Stale claim must not complete.' }), false, 'finished claims cannot be replayed');
  const safeQueueHealth = await agentQueue.getSafeTaskQueueHealth();
  assert.equal(safeQueueHealth.statuses.completed, 1);
  assert.equal(safeQueueHealth.content_read, false);
  const concurrentEnqueues = await Promise.all([
    agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:15'),
    agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:15'),
  ]);
  assert.equal(concurrentEnqueues.filter(result => result.created).length, 1,
    'concurrent idempotent enqueues create one task');
  const concurrentClaims = await Promise.all([agentQueue.claimSafeTasks(1), agentQueue.claimSafeTasks(1)]);
  assert.equal(concurrentClaims.reduce((total, tasks) => total + tasks.length, 0), 1,
    'a concurrent worker cannot claim the same task twice');
  const racedClaim = concurrentClaims.flat()[0];
  assert.equal(await agentQueue.finishSafeTask({ id: racedClaim.id, claimToken: racedClaim.claim_token,
    status: 'completed', summary: 'Concurrent synthetic claim completed once.' }), true);
  console.log('YDB_LOCAL_INTEGRATION_PASS: school profile/role/deletion requests, same-school account and listing deletion, school content/polls, own-profile identity, private media cleanup, manual school-scoped avatar review and approval, aggregate agent reports and school-bound idea review, allowlisted hourly error telemetry, idempotent concurrent enqueue and exclusive lease-based safe agent queue, persistent hourly listing/idea/image-upload quotas, four secondary lookup indexes, listings, favorites, ideas, messages, events, all on disposable synthetic local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
