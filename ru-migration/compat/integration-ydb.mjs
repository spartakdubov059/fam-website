Warning: truncated output (original token count: 27062)
Total output lines: 1147

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

// This script is intentionally hard-wired to the disposable local database.
const driver = new Driver('grpc://127.0.0.1:2136/local');
let syntheticPendingImages;
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => { const statement = client(strings, ...values); statement.on('error', () => {}); return statement; };
  sql.begin = client.begin.bind(client);
  const repo = createYdbListingsRepository(sql);
  const schemaHealth = await createYdbSchemaHealthCheck(sql, { identifier, fragment, join })();
  assert.deepEqual(schemaHealth, { ok: true, tables_checked: 37, content_read: false, write_permissions_checked: false });
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
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name)    VALUES ('https://issuer.synthetic', 'subject-safety-actor', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'synthetic-school', 'student', true, 'Тест', 'Нарушитель', '8Б');`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null, person_type: 'student', staff_position: null, staff_verification_status: 'not_required' });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
  const authenticate = async req => ({ issuer: 'https://issuer.synthetic', subject: ['Bearer synthetic-registrant', 'Bearer synthetic-recent-registrant'].includes(req.headers.authorization) ? 'subject-2'
      : req.headers.authorization === 'Bearer synthetic-admin' ? 'subject-admin'
        : req.headers.authorization === 'Bearer synthetic-media' ? 'subject-media'
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
  assert.o…21062 tokens truncated…LECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${recoveryUserId};`)?.[0]?.length ?? 0, 0);
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
  assert.deepEqual(await repo.createAvatarReview({ userId: quotaUserId, schoolId: 'synthetic-school', imageKey: quotaAvatarKey }),
    { ok: false, code: 'rate_limited' }, 'avatar submission shares the exhausted listing quota');
  const quotaAvatarState = await sql`SELECT status FROM fam_pending_media WHERE object_key = ${quotaAvatarKey} LIMIT 1;`;
  assert.equal(quotaAvatarState[0][0]?.status, 'pending', 'a rate-limited avatar upload remains unlinked for the client cleanup path');
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
  assert.equal(await agentQueue.finishSafeCoderTask({ id: coderClaim.id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: coderClaim.claim_token, resultCode: 'model_no_patch' }), true);
  assert.equal(await agentQueue.finishSafeCoderTask({ id: coderClaim.id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: coderClaim.claim_token, resultCode: 'model_no_patch' }), false, 'finished coder leases cannot be replayed');
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
  const scheduledWorker = createSafeAgentTaskWorker({ queue: agentQueue, handlers: {
    queue_health_check: async () => {
      const health = await agentQueue.getSafeTaskQueueHealth();
      return `Синтетическая проверка очередей: ожидают ${health.statuses.queued}; содержимое не читалось.`;
    },
    daily_report_digest: async () => {
      const result = await createOrchestratorDailyDigest({ repository: repo, now: () => new Date('2026-11-20T04:00:00.000Z') })();
      return `Синтетическая сводка за ${result.date} обработана агрегированно.`;
    },
    system_health_check: syntheticSystemHealth,
    site_error_digest: async () => {
      const result = await createSiteErrorDigest({ repository: repo, now: () => new Date('2026-11-20T04:30:00.000Z') })();
      return `Синтетическая сводка ошибок за ${result.slot} обработана агрегированно.`;
    },
  } });
  const scheduledRuns = [];
  for (const slot of ['2026-11-20T03:40:00.000Z', '2026-11-20T04:00:00.000Z', '2026-11-20T04:30:00.000Z']) {
    scheduledRuns.push(await createScheduledSafeAgentRunner({ queue: agentQueue, worker: scheduledWorker,
      now: () => new Date(slot) })());
  }
  assert.deepEqual(scheduledRuns.map(result => ({ scheduled: result.scheduled, created: result.created,
    claimed: result.claimed, completed: result.completed, blocked: result.blocked, failed: result.failed })), [
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
  ], 'all three source schedule slots enqueue and complete through the real YDB queue and safe worker');
  const scheduledRows = await sql`SELECT task_type, status FROM fam_agent_tasks WHERE source = 'scheduled_audit'
    AND task_type IN ('system_health_check', 'daily_report_digest', 'site_error_digest');`;
  assert.deepEqual(new Set((scheduledRows?.[0] ?? []).map(row => `${row.task_type}:${row.status}`)),
    new Set(['system_health_check:completed', 'daily_report_digest:completed', 'site_error_digest:completed']));
  console.log('YDB_LOCAL_INTEGRATION_PASS: school profile/role/deletion requests, same-school account and listing deletion, school content/polls, own-profile identity, private media cleanup, manual school-scoped avatar review and approval, aggregate agent reports and school-bound idea review, allowlisted hourly error telemetry, idempotent concurrent enqueue and exclusive lease-based safe agent queue, 03:40/04:00/hourly :30 UTC schedule-to-worker flows with synthetic health checks and real digest handlers, persistent hourly listing/idea/image-upload quotas, four secondary lookup indexes, listings, favorites, ideas, messages, events, all on disposable synthetic local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  syntheticPendingImages?.close();
  await driver.close();
}
