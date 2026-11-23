Warning: truncated output (original token count: 33913)
Total output lines: 1458

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { Driver } from '@ydbjs/core';
import { query, identifier, fragment, join } from '@ydbjs/query';
import sharp from 'sharp';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createYdbAgentTaskQueue } from '../app/backend/repositories/ydb-agent-task-queue.mjs';
import { createSafeAgentTaskWorker } from '../app/backend/services/safe-agent-task-worker.mjs';
import { createSystemHealthTaskHandler } from '../app/backend/services/system-health-task.mjs';
import { createOrchestratorDailyDigest } from '../app/backend/services/orchestrator-daily-digest.mjs';
import { createSiteErrorDigest } from '../app/backend/services/site-error-digest.mjs';
import { createScheduledSafeAgentRunner } from '../app/backend/services/scheduled-safe-agent-runner.mjs';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
import { createSuspensionWriteGuard } from '../app/backend/auth/suspension-write-guard.mjs';
import { createListingsApi } from '../app/backend/services/listings-api.mjs';
import { createMediaApi } from '../app/backend/services/media-api.mjs';
import { createS3PendingImageStore } from '../app/backend/media/s3-pending-store.mjs';
import { createAccountDeletionRecoveryOperation } from '../app/backend/services/recover-account-deletions.mjs';
import { createYdbSchemaHealthCheck } from '../app/backend/services/ydb-schema-health.mjs';
import { createRoleEmailVerification } from '../app/backend/services/role-email-verification.mjs';
import { createStepUpEmailVerification } from '../app/backend/services/step-up-email-verification.mjs';
import { createStepUpCookie } from '../app/backend/auth/step-up-cookie.mjs';

// This script is intentionally hard-wired to the disposable local database.
const driver = new Driver('grpc://127.0.0.1:2136/local');
let syntheticPendingImages;
let quotaPendingImages;
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => { const statement = client(strings, ...values); statement.on('error', () => {}); return statement; };
  sql.begin = client.begin.bind(client);
  const repo = createYdbListingsRepository(sql);
  const schemaHealth = await createYdbSchemaHealthCheck(sql, { identifier, fragment, join })();
  assert.deepEqual(schemaHealth, { ok: true, tables_checked: 39, content_read: false, write_permissions_checked: false });
  const stepClock = Math.floor(Date.now() / 1000) - 10;
  const stepVerifyClock = stepClock + 1;
  const stepIdentity = { issuer: 'https://issuer.synthetic', subject: 'step-up-subject', email: 'step-up@example.test' };
  const stepEmail = createStepUpEmailVerification({ repository: repo,
    verificationKey: 'synthetic-step-up-verification-secret-long-enough', now: () => stepVerifyClock * 1000,
    createCode: () => '654321', sendEmail: async email => { assert.equal(email.to, stepIdentity.email); assert.equal(email.purpose, 'step_up'); } });
  assert.deepEqual(await stepEmail.start(stepIdentity, 'synthetic-function-access-token-long-enough'), { ok: true, sent: true });
  const stepVerified = await stepEmail.verify(stepIdentity, '654321');
  assert.equal(stepVerified.ok, true);
  const verifiedStepCookie = createStepUpCookie({ secret: 'synthetic-step-up-secret-that-is-long-enough', secure: false,
    now: () => stepVerifyClock * 1000 });
  const issuedStepCookie = verifiedStepCookie.issue(stepIdentity);
  assert.equal(issuedStepCookie.confirmedAt, stepClock + 1);
  assert.equal(verifiedStepCookie.read({ headers: { cookie: issuedStepCookie.setCookie.split(';')[0] } }, stepIdentity), stepClock + 1);
  assert.equal((await stepEmail.verify(stepIdentity, '654321')).ok, false, 'the code cannot be reused');
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
    ('https://issuer.synthetic', 'subject-lyceum-admin', '44444444-4444-4444-8444-444444444444', 'lyceum_3', 'school_admin', true),
    ('https://issuer.synthetic', 'subject-media', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'synthetic-school', 'student', true);`;
  const adminRaceIds = [
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ];
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active) VALUES
    ('https://issuer.synthetic', 'subject-admin-race-a', ${adminRaceIds[0]}, 'synthetic-admin-race-school', 'school_admin', true),
    ('https://issuer.synthetic', 'subject-admin-race-b', ${adminRaceIds[1]}, 'synthetic-admin-race-school', 'school_admin', true);`;
  const adminRaceResults = await Promise.allSettled([
    repo.revokeSchoolRole({ schoolId: 'synthetic-admin-race-school', actorId: adminRaceIds[0], targetId: adminRaceIds[1] }),
    repo.revokeSchoolRole({ schoolId: 'synthetic-admin-race-school', actorId: adminRaceIds[1], targetId: adminRaceIds[0] }),
  ]);
  const adminRaceSuccesses = adminRaceResults.filter(result => result.status === 'fulfilled' && result.value?.ok);
  assert.equal(adminRaceSuccesses.length, 1,
    'serializable concurrent role revocations must allow at most one admin to lose the role');
  const losingAdminRace = adminRaceResults.filter(result => result.status === 'rejected' || !result.value?.ok);
  assert.equal(losingAdminRace.length, 1,
    'the competing demotion must stop after the other transaction changes its actor or target role');
  const remainingRaceAdmins = await sql`SELECT user_id FROM fam_user_profiles
    WHERE school_id = 'synthetic-admin-race-school' AND role = 'school_admin' AND active = true;`;
  assert.equal(remainingRaceAdmins?.[0]?.length, 1,
    'concurrent demotions must preserve one active school administrator');
  const accountRaceIds = [
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ];
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active) VALUES
    ('https://issuer.synthetic', 'subject-account-race-a', ${accountRaceIds[0]}, 'synthetic-account-race-school', 'school_admin', true),
    ('https://issuer.synthetic', 'subject-account-race-b', ${accountRaceIds[1]}, 'synthetic-account-race-school', 'school_admin', true);`;
  const accountRaceResults = await Promise.allSettled(accountRaceIds.map((userId, index) =>
    repo.beginAccountDeletion({ issuer: 'https://issuer.synthetic', subject: `subject-account-race-${index ? 'b' : 'a'}`, userId })));
  const accountRaceSuccesses = accountRaceResults.filter(result => result.status === 'fulfilled' && result.value?.ok);
  assert.equal(accountRaceSuccesses.length, 1,
    'serializable concurrent self-deletions must allow at most one administrator to deactivate');
  const losingAccountRace = accountRaceResults.filter(result => result.status === 'rejected' || !result.value?.ok);
  assert.equal(losingAccountRace.length, 1,
    'the competing self-deletion must stop after the other transaction deactivates its actor');
  const remainingAccountAdmins = await sql`SELECT user_id FROM fam_user_profiles
    WHERE school_id = 'synthetic-account-race-school' AND role = 'school_admin' AND active = true;`;
  assert.equal(remainingAccountAdmins?.[0]?.length, 1,
    'concurrent self-deletions must preserve one active school administrator');
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name)    VALUES ('https://issuer.synthetic', 'subject-safety-actor', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'synthetic-school', 'student', true, 'Тест', 'Нарушитель', '8Б');`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null, person_type: 'student', staff_position: null, staff_verification_status: 'not_required' });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
  const authenticate = async req => {
    const subject = ['Bearer synthetic-registrant', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? 'subject-2'
      : req.headers.authorization === 'Bearer synthetic-admin' ? 'subject-admin'
        : req.headers.authorization === 'Bearer synthetic-media' ? 'subject-media'
        : req.headers.authorization === 'Bearer synthetic-role-student' ? 'subject-role-student'
        : req.headers.authorization === 'Bearer synthetic-council' ? 'subject-council'
        : req.headers.authorization === 'Bearer synthetic-new-student' ? 'subject-new'
          : req.headers.authorization === 'Bearer synthetic-new-staff' ? 'subject-new-staff'
          : req.headers.authorization === 'Bearer synthetic-other-school' ? 'subject-3'
          : req.headers.authorization === 'Bearer synthetic-lyceum-admin' ? 'subject-lyceum-admin'
          : req.headers.authorization === 'Bearer synthetic-safety-actor' ? 'subject-safety-actor' : 'subject-1';
    return { issuer: 'https://issuer.synthetic', subject,
      ...(subject === 'subject-role-student' ? { email: 'role-student@synthetic.example' } : {}),
      ...(subject === 'subject-new' ? { email: 'new-student@synthetic.example' } : {}),
      ...(subject === 'subject-new-staff' ? { email: 'new-staff@synthetic.example' } : {}),
      authenticated_at: ['Bearer synthetic-admin', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? Math.floor(Date.now() / 1000) : null };
  };
  const deletedMediaKeys = [];
  const accountMediaKeys = new Set();
  let syntheticVerificationEmail;
  const emailVerificationKey = 'local-ci-only-synthetic-role-email-key-over-32-bytes';
  const emailVerification = createRoleEmailVerification({ repository: repo, verificationKey: emailVerificationKey,
    sendEmail: async message => { syntheticVerificationEmail = message; }, now: () => 1_800_000_000_000, createCode: () => '135790' });
  assert.equal(emailVerification.available, true, 'YDB repository and synthetic email sender configure the verifier');
  const reserveRoleEmailChallenge = repo.startRoleEmailVerification.bind(repo);
  repo.startRoleEmailVerification = async input => {
    try { return await reserveRoleEmailChallenge(input); }
    catch (error) {
      const chain = [];
      for (let current = error, depth = 0; current && depth < 3; current = current.cause, depth += 1) {
        chain.push(`${current?.name || 'Error'}: ${String(current?.message || 'unknown')}`);
        if (Array.isArray(current?.issues)) chain.push(JSON.stringify(current.issues));
      }
      const diagnostic = chain.join(' <- ').replace(/https:\/\/issuer\.synthetic/g, '[issuer]')
        .replace(/subject-role-student/g, '[subject]').replace(/[a-f0-9]{64}/gi, '[digest]')
        .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[id]').slice(0, 2400);
      console.error('YDB_ROLE_EMAIL_CHALLENGE_ERROR:', diagnostic);
      throw error;
    }
  };
  const listingsApi = createSuspensionWriteGuard({ authenticate, resolveActor, repository: repo })(createListingsApi({
    authenticate,
    resolveActor,
    repository: repo,
    safetyKey: 'local-ci-only-synthetic-safety-key-over-32-bytes',
    verificationKey: emailVerificationKey,
    sendRoleVerificationEmail: async message => { syntheticVerificationEmail = message; },
    emailVerification,
    pendingImages: {
      get: async () => Buffer.from('synthetic-webp'),
      delete: async key => { deletedMediaKeys.push(key); accountMediaKeys.delete(key); },
      listUserObjects: async userId => [...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)),
      listAccountObjects: async (userId, ownedKeys = []) => [...new Set([
        ...[...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)), ...ownedKeys,
      ])],
    },
  }));
  const apiRequest = (method, url, token, body = {}) => {
    const request = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = method; request.url = url; request.headers = { authorization: `Bearer ${token}` };
    return request;  };
  const privateObjects = new Map();
  syntheticPendingImages = createS3PendingImageStore({
    FAM_RU_S3_ENDPOINT: 'http://127.0.0.1:9000',
    FAM_RU_S3_BUCKET: 'synthetic-private',
    FAM_RU_S3_ACCESS_KEY_ID: 'synthetic-access',
    FAM_RU_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
  }, {
    send: async input => { privateObjects.set(input.Key, { body: Buffer.from(input.Body), contentType: input.ContentType }); },
    get: async input => {
      const object = privateObjects.get(input.Key);
      return object ? { ContentType: object.contentType, ContentLength: object.body.length,
        Body: { transformToByteArray: async () => object.body } } : null;
    },
    remove: async input => { privateObjects.delete(input.Key); },
    list: async input => ({ Contents: [...privateObjects.keys()].filter(key => key.startsWith(input.Prefix)).map(Key => ({ Key })), IsTruncated: false }),
  });
  const mediaApi = createMediaApi({ authenticate, resolveActor, repository: repo, pendingImages: syntheticPendingImages });
  const ownerPrivatePhotoKey = 'pending/11111111-1111-4111-8111-111111111111/12121212-1212-4212-8212-121212121212.webp';
  await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', ownerPrivatePhotoKey);
  privateObjects.set(ownerPrivatePhotoKey, { body: Buffer.from('synthetic-webp'), contentType: 'image/webp' });
  const ownerPrivateListing = await repo.createListing({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school',
    title: 'Синтетическое неопубликованное объявление автора', description: 'Проверка доступа автора к своему одобренному фото',
    category: 'Учёба', price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: ownerPrivatePhotoKey,
    photo_status: 'approved', status: 'pending' });
  assert.equal((await mediaApi(apiRequest('GET', `/api/v1/listings/${ownerPrivateListing.id}/photo`, 'synthetic-registrant'))).status, 200,
    'the listing author can read their approved photo before the listing becomes public');
  assert.equal((await mediaApi(apiRequest('GET', `/api/v1/listings/${ownerPrivateListing.id}/photo`, 'synthetic-media'))).status, 404,
    'another student in the same school cannot read a non-public listing photo');
  const syntheticPng = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 42, g: 90, b: 140 } } }).png().toBuffer();
  const uploadRequest = Readable.from([syntheticPng]);
  uploadRequest.method = 'POST'; uploadRequest.url = '/api/v1/media/pending';
  uploadRequest.headers = { authorization: 'Bearer synthetic-media', 'content-type': 'image/png', 'content-length': String(syntheticPng.length) };
  const mediaUpload = await mediaApi(uploadRequest);
  assert.equal(mediaUpload.status, 201);
  const mediaKey = mediaUpload.body.image.key;
  const storedImage = privateObjects.get(mediaKey);
  assert.equal(storedImage?.contentType, 'image/webp');
  assert.equal((await sharp(storedImage.body).metadata()).format, 'webp', 'the synthetic upload is actually decoded and re-encoded');
  const pendingMediaRow = await sql`SELECT user_id, status FROM fam_pending_media WHERE object_key = ${mediaKey} LIMIT 1;`;
  assert.deepEqual(pendingMediaRow[0][0], { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'pending' });
  const mediaListing = await repo.createListing({ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', school_id: 'synthetic-school',
    title: 'Синтетическое фото', description: 'Проверка загрузки', category: 'Вещи', price_text: 'Бесплатно', is_event: false,
    event_date: null, event_time: null, event_type: null, max_seats: 0, image_key: mediaKey, photo_status: 'pending', status: 'pending' });
  assert.ok(mediaListing?.id, 'the verified uploader can link their own private image to a pending listing');
  const linkedMediaRow = await sql`SELECT status FROM fam_pending_media WHERE object_key = ${mediaKey} LIMIT 1;`;
  assert.equal(linkedMediaRow[0][0].status, 'linked');
  await syntheticPendingImages.close();
  syntheticPendingImages = null;
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
  assert.equal(revokedAudit[0][0].action, 'role_revoked');  assert.equal(revokedAudit[0][0].previous_role, 'council_member');
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
  const longOpenEventDescription = 'Открытое школьное событие. '.repeat(30);
  await sql`INSERT INTO fam_listings (id, user_id, school_id, title, description, category, price_text,
      is_event, event_date, event_time, event_type, max_seats, image_key, photo_status, status, created_at)
    VALUES ('synthetic-open-event', 'synthetic-user', 'synthetic-school', 'Открытый день школы', ${longOpenEventDescription},
      'Мероприятия', 'Бесплатно', true, '2099-12-31', '12:00', 'open', 0, '', 'none', 'active', CurrentUtcTimestamp());`;
  await sql`INSERT INTO fam_listings (id, user_id, school_id, title, description, category, price_text,
      is_event, event_date, event_time, event_type, max_seats, image_key, photo_status, status, created_at)
    VALUES ('synthetic-limited-event', 'synthetic-user', 'synthetic-school', 'Событие с местами', 'Закрытая регистрация',
      'Мероприятия', 'Бесплатно', true, '2099-12-31', '12:00', 'open', 10, '', 'none', 'active', CurrentUtcTimestamp());`;
  await sql`INSERT INTO fam_listings (id, user_id, school_id, title, description, category, price_text,
      is_event, event_date, event_time, event_type, max_seats, image_key, photo_status, status, created_at)
    VALUES ('synthetic-expired-event', 'synthetic-user', 'synthetic-school', 'Прошедшее событие', 'Дата уже прошла',
      'Мероприятия', 'Бесплатно', true, '2000-01-01', '12:00', 'open', 0, '', 'none', 'active', CurrentUtcTimestamp());`;
  const pulsePoll = await listingsApi(apiRequest('POST', '/api/v1/pulse/polls', 'synthetic-council', {
    question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика', 'Приключения', 'Детектив', 'Научная фантастика', 'Поэзия', 'История', 'Другое'],
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
  const openEvent = pulseRead.body.announcements.find(row => row.id === 'synthetic-open-event');
  assert.equal(openEvent?.kind, 'open_event', 'active no-capacity event is included in school pulse');
  assert.equal(openEvent.event_date, '2099-12-31');
  assert.ok(Array.from(openEvent.body).length <= 450, 'event description is capped by Unicode characters');
  assert.equal(pulseRead.body.announcements.some(row => row.id === 'synthetic-limited-event'), false,
    'events with a seat limit do not enter open-event feed');
  assert.equal(pulseRead.body.announcements.some(row => row.id === 'synthetic-expired-event'), false,
    'past events do not enter the feed');
  assert.ok(pulseRead.body.polls.some(row => row.id === pulsePoll.body.id));
  const pollVoters = ['synthetic-user', 'synthetic-registrant', 'synthetic-role-student', 'synthetic-admin', 'synthetic-council'];
  for (const [index, token] of pollVoters.entries()) {
    const vote = await listingsApi(apiRequest('POST', `/api/v1/pulse/polls/${pulsePoll.body.id}/votes`, token, { choice_index: index === 4 ? 7 : index * 2 }));
    assert.equal(vote.status, 201);
  }  const duplicatePollVote = await listingsApi(apiRequest('POST', `/api/v1/pulse/polls/${pulsePoll.body.id}/votes`, 'synthetic-registrant', { choice_index: 0 }));
  assert.equal(duplicatePollVote.status, 409);
  const invalidUpperPollVote = await listingsApi(apiRequest('POST', `/api/v1/pulse/polls/${pulsePoll.body.id}/votes`, 'synthetic-admin', { choice_index: 8 }));
  assert.equal(invalidUpperPollVote.status, 400);
  const otherSchoolPulse = await listingsApi(apiRequest('GET', '/api/v1/pulse', 'synthetic-other-school'));
  assert.equal(otherSchoolPulse.status, 200);
  assert.equal(otherSchoolPulse.body.announcements.length, 0, 'school pulse feed cannot cross school boundaries');
  const pulseAfterVotes = await listingsApi(apiRequest('GET', '/api/v1/pulse', 'synthetic-registrant'));
  const visiblePoll = pulseAfterVotes.body.polls.find(row => row.id === pulsePoll.body.id);
  assert.equal(visiblePoll.total_votes, 5);
 …13913 tokens truncated…l((await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-lyceum-admin'))).body.reports.length, 0,
    'safety reports are isolated by school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', '/api/v1/school/admin/safety-reports', 'synthetic-admin', {    fingerprint: safetyFingerprint, category: 'targeted_harassment', source_kind: 'message',
  })), { status: 200, body: { ok: true } });
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-admin'))).body.reports.some(row => row.fingerprint === safetyFingerprint), false,
    'acknowledged safety clusters leave the unreviewed queue');
  const adminIdeaImageKey = 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-0000-4000-8000-000000000001.webp';
  accountMediaKeys.add(adminIdeaImageKey);
  await repo.registerPendingImage('33333333-3333-4333-8333-333333333333', adminIdeaImageKey);
  const adminOwnIdea = await repo.createIdea({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    text: 'Идея администратора для самопроверки', image_keys: [adminIdeaImageKey], image_status: 'pending',
    ai_status: 'approved', admin_status: 'new' });
  assert.equal((await repo.listPendingSchoolIdeas('synthetic-school', '33333333-3333-4333-8333-333333333333', 'school_admin'))
    .some(idea => idea.id === adminOwnIdea.id), false, 'review queue omits the reviewer own submission');
  assert.equal(await repo.reviewSchoolIdeaImages({ ideaId: adminOwnIdea.id, schoolId: 'synthetic-school',
    reviewerId: '33333333-3333-4333-8333-333333333333', decision: 'approve' }), false,
  'school staff cannot approve their own idea photo');
  const deletedAdminIdea = await listingsApi(apiRequest('DELETE', `/api/v1/ideas/${adminOwnIdea.id}`, 'synthetic-admin', null));
  assert.deepEqual(deletedAdminIdea, { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } },
    'an idea author can delete their own idea and immediately clean linked private photos');
  assert.ok(deletedMediaKeys.includes(adminIdeaImageKey));
  assert.equal((await sql`SELECT id FROM fam_ideas WHERE id = ${adminOwnIdea.id};`)[0].length, 0);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${adminIdeaImageKey};`)[0].length, 0);
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
  assert.equal(submittedIdea.ai_status, 'approved', 'unflagged text follows the free local fallback review path');
  assert.ok((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-council'))).body.ideas
    .some(item => item.id === ideaSubmission.body.id), 'council can review photos after the text passes the local safety gate');
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-lyceum-admin'))).body.ideas, [],
    'school idea queue is isolated by school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${ideaSubmission.body.id}/images`, 'synthetic-council', { decision: 'approve' })),
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
  assert.deepEqual(await repo.listPendingSchoolIdeas('synthetic-school', '66666666-6666-4666-8666-666666666666', 'council_member')
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
    { status: 200, body: { ok: true, ai_status: 'rejected' } });  assert.equal((await repo.listPendingSchoolIdeas('synthetic-school', '66666666-6666-4666-8666-666666666666', 'council_member'))
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
  assert.deepEqual(accountDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 4 } });
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
  const requestedAvatarKey = `pending/${requestedTargetId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.webp`;
  accountMediaKeys.add(requestedAvatarKey);
  await repo.registerPendingImage(requestedTargetId, requestedAvatarKey);
  await sql`INSERT INTO fam_avatar_reviews (id, user_id, school_id, image_key, status, created_at, reviewed_by, reviewed_at)
    VALUES ('eeeeeeee-0000-4000-8000-000000000001', ${requestedTargetId}, 'synthetic-school', ${requestedAvatarKey}, 'pending', CurrentUtcTimestamp(), '', NULL);`;
  await sql`INSERT INTO fam_notification_reads (user_id, notification_key, read_at)
    VALUES (${requestedTargetId}, 'synthetic-notification', CurrentUtcTimestamp());`;
  await sql`INSERT INTO fam_submission_quotas (user_id, action, window_start, submission_count)
    VALUES (${requestedTargetId}, 'listing', CurrentUtcTimestamp(), Unwrap(CAST(1 AS Uint32)));`;
  const deletionAuditId = 'eeeeeeee-0000-4000-8000-000000000002';
  await sql`INSERT INTO fam_school_content_audit (event_id, school_id, actor_id, entity_id, entity_type, action, details, created_at)
    VALUES (${deletionAuditId}, 'synthetic-school', ${requestedTargetId}, 'synthetic-entity', 'listing', 'synthetic_review', '{}', CurrentUtcTimestamp());`;
  const deletionSafetyFingerprint = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const deletionSafetyId = 'eeeeeeee-0000-4000-8000-000000000003';
  await sql`INSERT INTO fam_safety_incidents (school_id, pair_fingerprint, source_kind, category, incident_id, severity,
    created_at, reviewed_at, reviewed_by, actor_id, target_id, source_origin, evidence_excerpt)
    VALUES ('synthetic-school', ${deletionSafetyFingerprint}, 'message', 'targeted_harassment', ${deletionSafetyId}, 'medium',
      CurrentUtcTimestamp(), NULL, NULL, ${requestedTargetId}, '33333333-3333-4333-8333-333333333333', 'fam.example.ru', 'sanitized synthetic evidence');`;
  const requestedDeletion = await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-council', {
    target_id: requestedTargetId, reason_code: 'spam', reason: 'Repeated unrelated messages in the synthetic school test.',
  }));
  assert.equal(requestedDeletion.status, 202);
  const approvedDeletion = await listingsApi(apiRequest('PATCH', `/api/v1/deletion-requests/${requestedDeletion.body.request_id}`, 'synthetic-admin', {    decision: 'approve', confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА', review_note: 'Подтверждено синтетическим тестом',
  }));
  assert.deepEqual(approvedDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 2 } });
  assert.ok(deletedMediaKeys.includes(requestedImageKey), 'approved deletion removes private media for the requested synthetic account');
  assert.ok(deletedMediaKeys.includes(requestedAvatarKey), 'approved deletion also removes a linked avatar object');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-delete-target' }), null,
    'approved deletion removes the requested profile identity mapping');
  assert.equal((await sql`SELECT id FROM fam_avatar_reviews WHERE user_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT notification_key FROM fam_notification_reads WHERE user_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT action FROM fam_submission_quotas WHERE user_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0);
  const anonymizedAudit = await sql`SELECT actor_id FROM fam_school_content_audit WHERE event_id = ${deletionAuditId};`;
  assert.equal(anonymizedAudit?.[0]?.[0]?.actor_id, 'deleted-account');
  const anonymizedSafety = await sql`SELECT actor_id, target_id, source_origin, evidence_excerpt FROM fam_safety_incidents
    WHERE school_id = 'synthetic-school' AND pair_fingerprint = ${deletionSafetyFingerprint} AND incident_id = ${deletionSafetyId};`;
  assert.deepEqual(anonymizedSafety?.[0]?.[0], { actor_id: null, target_id: null, source_origin: null, evidence_excerpt: null });
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
      listAccountObjects: async (userId, ownedKeys = []) => [...new Set([
        ...[...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)), ...ownedKeys,
      ])],
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
  const quotaAvatarKey = `pending/${quotaUserId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
  await repo.registerPendingImage(quotaUserId, quotaAvatarKey);
  privateObjects.set(quotaAvatarKey, { body: Buffer.from('synthetic-webp'), contentType: 'image/webp' });
  quotaPendingImages = createS3PendingImageStore({
    FAM_RU_S3_ENDPOINT: 'http://127.0.0.1:9000', FAM_RU_S3_BUCKET: 'synthetic-private',
    FAM_RU_S3_ACCESS_KEY_ID: 'synthetic-access', FAM_RU_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
  }, {
    send: async input => { privateObjects.set(input.Key, { body: Buffer.from(input.Body), contentType: input.ContentType }); },
    get: async input => {
      const object = privateObjects.get(input.Key);
      return object ? { ContentType: object.contentType, ContentLength: object.body.length,
        Body: { transformToByteArray: async () => object.body } } : null;
    },
    remove: async input => { privateObjects.delete(input.Key); },
  });
  const quotaAvatarApi = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.synthetic', subject: 'quota-avatar-user' }),
    resolveActor: async () => ({ id: quotaUserId, school_id: 'synthetic-school', role: 'student' }), repository: repo,
    pendingImages: quotaPendingImages });
  const quotaAvatarResponse = await quotaAvatarApi(apiRequest('POST', '/api/v1/me/avatar', 'quota-avatar', { image_key: quotaAvatarKey }));
  assert.equal(quotaAvatarResponse.status, 429, 'avatar submission shares the exhausted listing quota');
  assert.equal(privateObjects.has(quotaAvatarKey), false, 'the rejected avatar object is removed from private storage');
  const quotaAvatarState = await sql`SELECT status FROM fam_pending_media WHERE object_key = ${quotaAvatarKey} LIMIT 1;`;
  assert.equal(quotaAvatarState[0].length, 0, 'the rejected avatar registration is removed through the cleanup lease');
  const rejectedAvatar = await sql`SELECT id FROM fam_avatar_reviews WHERE user_id = ${quotaUserId} AND status = 'pending';`;
  assert.equal(rejectedAvatar[0].length, 0, 'a rate-limited avatar is not queued for review');
  const quotaIdea = { user_id: quotaUserId, school_id: 'synthetic-school', text: 'Синтетическая идея',
    ai_status: 'pending', ai_summary: 'Идея', ai_reason: 'review_unavailable', admin_status: 'new' };
  for (let i = 0; i < 5; i++) await repo.createIdea(quotaIdea);
  assert.deepEqual(await repo.createIdea(quotaIdea), { ok: false, code: 'rate_limited' },
    'the sixth idea in one hour is rejected for this synthetic account');
  for (let i = 0; i < 5; i++) await repo.reserveImageUpload(quotaUserId);
  assert.equal(await repo.reserveImageUpload(quotaUserId), false,
    'a sixth image decode reservation in one hour is rejected for this synthetic account');
  const quotaRows = await sql`SELECT action, submission_count FROM fam_submission_quotas WHERE user_id = ${quotaUserId};`;
  assert.deepEqual(Object.fromEntries(quotaRows[0].map(row => [row.action, Number(row.submission_count)])), { idea: 5, image_upload: 5, listing: 5 });
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
  const initialCoderQueueHealth = await agentQueue.getAgentTaskQueueHealth();
  assert.equal(initialCoderQueueHealth.queued, 1);
  assert.equal(initialCoderQueueHealth.claimed, 0);
  assert.deepEqual(Object.keys(initialCoderQueueHealth).sort(),
    ['claimed', 'expired_leases', 'failed_last_24h', 'in_progress', 'oldest_queued_minutes', 'queued']);
  const initialAgentMetrics = await agentQueue.getAgentTaskMetrics();
  assert.ok(initialAgentMetrics.some(row => row.agent_key === 'technical' && row.status === 'queued' && row.count === 1));
  assert.ok(initialAgentMetrics.every(row => Object.keys(row).sort().join(',') === 'agent_key,count,status'),
    'task metrics expose only the allowlisted aggregate contract');
  assert.equal((await agentQueue.enqueueSafeCoderTask(coderSlot)).created, false, 'coder task enqueue is idempotent per quarter-hour slot');
  const claimedBeforeCoder = await agentQueue.claimSafeTasks(5);
  assert.equal(claimedBeforeCoder.some(task => task.task_type === 'coder_patch_request'), false,
    'the automated worker allowlist never claims coder tasks');
  const queuedCoder = await sql`SELECT status, payload_json FROM fam_agent_tasks WHERE id = ${coderTask.id};`;
  assert.equal(queuedCoder?.[0]?.[0]?.status, 'queued', 'coder task stays out of the automated safe worker');
  const coderPayload = JSON.parse(queuedCoder?.[0]?.[0]?.payload_json ?? 'null');
  assert.deepEqual(Object.keys(coderPayload).sort(), ['event_code', 'occurrences', 'page_area', 'task_key'],
    'coder task carries only the fixed aggregate schema');
  assert.equal(coderPayload.task_key, coderTask.task_key);
  assert.ok(['js_runtime', 'unhandled_rejection', 'listings_load_failed'].includes(coderPayload.event_code));
  assert.ok(['auth', 'listings', 'notifications', 'database', 'other'].includes(coderPayload.page_area));
  assert.ok(Number.isInteger(coderPayload.occurrences) && coderPayload.occurrences >= 3 && coderPayload.occurrences <= 1000);
  const coderClaim = await agentQueue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
  assert.equal(coderClaim.id, coderTask.id);
  assert.equal(coderClaim.task_key, coderPayload.task_key);
  const claimedCoderQueueHealth = await agentQueue.getAgentTaskQueueHealth();
  assert.equal(claimedCoderQueueHealth.queued, 0);
  assert.equal(claimedCoderQueueHealth.claimed, 1);
  const claimedAgentMetrics = await agentQueue.getAgentTaskMetrics();
  assert.ok(claimedAgentMetrics.some(row => row.agent_key === 'technical' && row.status === 'claimed' && row.count === 1));
  assert.equal(await agentQueue.finishSafeCoderTask({ id: coderClaim.id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: coderClaim.claim_token, resultCode: 'model_no_patch' }), true);
  assert.equal(await agentQueue.finishSafeCoderTask({ id: coderClaim.id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: coderClaim.claim_token, resultCode: 'model_no_patch' }), false, 'finished coder leases cannot be replayed');
  const retryTaskId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const retryPayload = JSON.stringify({ task_key: 'audit_frontend_runtime', event_code: 'js_runtime', page_area: 'other', occurrences: 3 });
  await sql`INSERT INTO fam_agent_tasks
    (id, agent_key, task_type, title, description, priority, status, source, approval_required,
      payload_json, result_summary, attempt_count, max_attempts, available_at, claim_token,
      claimed_by, claimed_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
    VALUES (${retryTaskId}, 'technical', 'coder_patch_request', 'Synthetic retry lifecycle',
      'Synthetic data only.', 'normal', 'claimed', 'scheduled_audit', false, ${retryPayload}, 'stale result',
      Unwrap(CAST(1 AS Uint32)), Unwrap(CAST(3 AS Uint32)), CurrentUtcTimestamp(), 'stale-token',
      'fam-agent-qwen-coder-v1', CurrentUtcTimestamp() - Interval('PT3H'),
      CurrentUtcTimestamp() - Interval('PT1H'), CurrentUtcTimestamp() - Interval('PT3H'),
      CurrentUtcTimestamp(), CurrentUtcTimestamp() - Interval('PT3H'), CurrentUtcTimestamp() - Interval('PT1H'));`;
  const retryClaim = await agentQueue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
  assert.equal(retryClaim.id, retryTaskId, 'an expired attempt is requeued and claimed again');
  assert.notEqual(retryClaim.claim_token, 'stale-token');
  const retriedRow = await sql`SELECT status, attempt_count, claim_token, started_at, finished_at, result_summary
    FROM fam_agent_tasks WHERE id = ${retryTaskId} LIMIT 1;`;
  assert.equal(retriedRow?.[0]?.[0]?.status, 'claimed');
  assert.equal(retriedRow?.[0]?.[0]?.attempt_count, 2);
  assert.equal(retriedRow?.[0]?.[0]?.claim_token, retryClaim.claim_token);
  assert.equal(retriedRow?.[0]?.[0]?.started_at, null);
  assert.equal(retriedRow?.[0]?.[0]?.finished_at, null);
  assert.ok(retriedRow?.[0]?.[0]?.result_summary?.includes('принято локальным анализатором'));
  assert.ok((await sql`SELECT event_type FROM fam_agent_task_events WHERE task_id = ${retryTaskId};`)
    ?. [0]?.some(event => event.event_type === 'retry_scheduled'));
  await sql`DELETE FROM fam_agent_task_events WHERE task_id = ${retryTaskId};`;
  await sql`DELETE FROM fam_agent_tasks WHERE id = ${retryTaskId};`;
  await sql`DELETE FROM fam_site_error_counts
    WHERE hour_bucket = Unwrap(CAST(${coderBucket.toISOString()} AS Timestamp))
      AND event_code = 'js_runtime' AND page_area = 'auth';`;
  for (const [index, [eventCode, pageArea, taskKey]] of [
    ['notifications_load_failed', 'notifications', 'audit_client_resilience'],
    ['database_request_failed', 'database', 'audit_client_resilience'],
    ['auth_backend_failed', 'auth', 'audit_client_resilience'],
  ].entries()) {
    await sql`DELETE FROM fam_site_error_counts WHERE event_code IN
      ('js_runtime', 'unhandled_rejection', 'listings_load_failed', 'notifications_load_failed',
        'database_request_failed', 'auth_backend_failed');`;
    const eventBucket = new Date();
    eventBucket.setUTCMinutes(0, 0, 0);
    await sql`UPSERT INTO fam_site_error_counts
      (hour_bucket, event_code, page_area, event_count, created_at, updated_at)
      VALUES (Unwrap(CAST(${eventBucket.toISOString()} AS Timestamp)), ${eventCode}, ${pageArea},
        Unwrap(CAST(3 AS Uint32)), CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
    const followupSlotDate = new Date(coderSlotDate.getTime() + (index + 1) * 15 * 60 * 1000);
    const followupTask = await agentQueue.enqueueSafeCoderTask(followupSlotDate.toISOString().slice(0, 16));
    assert.equal(followupTask.created, true, `${eventCode} aggregate creates a synthetic coder review task`);
    assert.equal(followupTask.task_key, taskKey, `${eventCode} maps to its fixed task key`);
    const followupPayloadRows = await sql`SELECT status, payload_json FROM fam_agent_tasks WHERE id = ${followupTask.id} LIMIT 1;`;
    assert.equal(followupPayloadRows?.[0]?.[0]?.status, 'queued',
      'new coder task remains outside the automated safe-worker allowlist');
    const followupPayload = JSON.parse(followupPayloadRows?.[0]?.[0]?.payload_json ?? 'null');
    assert.deepEqual(followupPayload, { task_key: taskKey, event_code: eventCode, page_area: pageArea, occurrences: 3 });
    const followupClaim = await agentQueue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
    assert.equal(followupClaim.id, followupTask.id);
    assert.equal(followupClaim.event_code, eventCode);
    assert.equal(await agentQueue.finishSafeCoderTask({ id: followupClaim.id, workerId: 'fam-agent-qwen-coder-v1',
      claimToken: followupClaim.claim_token, resultCode: 'model_no_patch' }), true);
    await sql`DELETE FROM fam_site_error_counts
      WHERE hour_bucket = Unwrap(CAST(${eventBucket.toISOString()} AS Timestamp))
        AND event_code = ${eventCode} AND page_area = ${pageArea};`;
  }
  const lifecycleTaskId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const lifecyclePayload = JSON.stringify({ task_key: 'audit_frontend_runtime', event_code: 'js_runtime', page_area: 'other', occurrences: 3 });
  await sql`INSERT INTO fam_agent_tasks
    (id, agent_key, task_type, title, description, priority, status, source, approval_required,
      payload_json, result_summary, attempt_count, max_attempts, available_at, claim_token,
      claimed_by, claimed_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
    VALUES (${lifecycleTaskId}, 'technical', 'coder_patch_request', 'Synthetic lifecycle verification',
      'Synthetic data only.', 'normal', 'queued', 'scheduled_audit', false, ${lifecyclePayload}, NULL,
      Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(1 AS Uint32)), CurrentUtcTimestamp(), NULL, NULL, NULL,
      NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
  const lifecycleClaim = await agentQueue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
  assert.equal(lifecycleClaim.id, lifecycleTaskId);
  assert.equal(await agentQueue.startSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token }), true);
  assert.equal(await agentQueue.heartbeatSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token }), true);
  assert.equal(await agentQueue.advanceSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token, stage: 'model_generated' }), true);
  assert.equal(await agentQueue.heartbeatSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token }), true);
  assert.equal(await agentQueue.advanceSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token, stage: 'qa_passed' }), true);
  assert.equal(await agentQueue.advanceSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token, stage: 'pr_created', prNumber: 42 }), true);
  const lifecycleResult = await sql`SELECT status, claimed_by, claim_token, lease_expires_at, result_summary
    FROM fam_agent_tasks WHERE id = ${lifecycleTaskId} LIMIT 1;`;
  assert.equal(lifecycleResult?.[0]?.[0]?.status, 'in_progress');
  assert.equal(lifecycleResult?.[0]?.[0]?.claimed_by, null, 'PR handoff releases the worker');
  assert.equal(lifecycleResult?.[0]?.[0]?.claim_token, null);
  assert.equal(lifecycleResult?.[0]?.[0]?.lease_expires_at, null);
  assert.match(lifecycleResult?.[0]?.[0]?.result_summary ?? '', /№42/);
  assert.equal(await agentQueue.heartbeatSafeCoderTask({ id: lifecycleTaskId, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: lifecycleClaim.claim_token }), false, 'a released claim cannot heartbeat or replay');
  await sql`DELETE FROM fam_agent_task_events WHERE task_id = ${lifecycleTaskId};`;
  await sql`DELETE FROM fam_agent_tasks WHERE id = ${lifecycleTaskId};`;
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
  const syntheticSystemHealth = createSystemHealthTaskHandler({
    readinessCheck: async () => ({ ready: true, services: { auth: true, database: true, objectStorage: true } }),
    timerCheck: async () => ({ ok: true, timers: [{ unit: 'fam-ru-synthetic.timer', ok: true }] }),
    queueHealthCheck: async () => {
      const health = await repo.getRuBackgroundQueueHealth();
      const safeTasks = await agentQueue.getSafeTaskQueueHealth();
      return { ...health, queues: { ...health.queues, safe_agent_tasks: safeTasks }, content_read: false };
    },
    schemaCheck: async () => schemaHealth,
  });
  let scheduledTime = new Date('2026-11-20T03:40:00.000Z');
  const scheduledWorker = createSafeAgentTaskWorker({ queue: agentQueue, handlers: {
    queue_health_check: async () => {
      const health = await agentQueue.getSafeTaskQueueHealth();
      return `Синтетическая проверка очередей: ожидают ${health.statuses.queued}; содержимое не читалось.`;
    },
    daily_report_digest: async () => {
      const result = await createOrchestratorDailyDigest({ repository: repo, now: () => scheduledTime })();
      return `Синтетическая сводка за ${result.date} обработана агрегированно.`;
    },
    system_health_check: syntheticSystemHealth,
    site_error_digest: async () => {
      const result = await createSiteErrorDigest({ repository: repo, now: () => scheduledTime })();
      return `Синтетическая сводка ошибок за ${result.slot} обработана агрегированно.`;
    },
  } });
  const scheduledRuns = [];
  for (const slot of ['2026-11-20T03:40:00.000Z', '2026-11-20T04:00:00.000Z', '2026-11-20T04:15:00.000Z', '2026-11-20T04:30:00.000Z', '2026-11-20T04:45:00.000Z']) {
    scheduledTime = new Date(slot);
    scheduledRuns.push(await createScheduledSafeAgentRunner({ queue: agentQueue, worker: scheduledWorker,
      now: () => new Date(slot) })());
  }
  assert.deepEqual(scheduledRuns.map(result => ({ scheduled: result.scheduled, created: result.created,
    claimed: result.claimed, completed: result.completed, blocked: result.blocked, failed: result.failed })), [
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 2, created: 2, claimed: 2, completed: 2, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
  ], 'all five source schedule slots enqueue and complete through the real YDB queue and safe worker');
  const scheduledRows = await sql`SELECT task_type, status FROM fam_agent_tasks WHERE source = 'scheduled_audit'
    AND task_type IN ('system_health_check', 'daily_report_digest', 'site_error_digest');`;
  assert.deepEqual(new Set((scheduledRows?.[0] ?? []).map(row => `${row.task_type}:${row.status}`)),
    new Set(['system_health_check:completed', 'daily_report_digest:completed', 'site_error_digest:completed']));
  console.log('YDB_LOCAL_INTEGRATION_PASS: school profile/role/deletion requests, same-school account and listing deletion, school content/polls, own-profile identity, private media cleanup, manual school-scoped avatar review and approval, aggregate agent reports and school-bound idea review, allowlisted 15-minute error telemetry, idempotent concurrent enqueue and exclusive lease-based safe agent queue, 03:40/04:00 and quarter-hour UTC schedule-to-worker flows with synthetic health checks and real digest handlers, persistent hourly listing/idea/image-upload quotas, four secondary lookup indexes, listings, favorites, ideas, messages, events, all on disposable synthetic local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  syntheticPendingImages?.close();
  quotaPendingImages?.close();
  await driver.close();
}
