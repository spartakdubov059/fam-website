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
import { createSchoolAgentReports } from '../app/backend/services/school-agent-reports.mjs';

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
  assert.deepEqual(schemaHealth, { ok: true, tables_checked: 36, content_read: false, write_permissions_checked: false });
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
  assert.ok(Number.isInteger(agentMetrics.listings.active));
  const refreshSchoolReport = createSchoolAgentReports({
    repository: repo,
    schools: [{ id: 'synthetic-school' }],
    now: () => new Date('2026-11-22T04:10:00.000Z'),
  });
  assert.deepEqual(await refreshSchoolReport(), { refreshed: 1 });
  const schoolAgentReport = await sql`SELECT report_date, summary, metrics_json FROM fam_agent_school_daily_reports WHERE school_id = 'synthetic-school' AND report_date = '2026-11-22';`;
  assert.equal(schoolAgentReport?.[0]?.[0]?.report_date, '2026-11-22');
  assert.match(schoolAgentReport[0][0].summary, /FAM — сводка за 2026-11-22/);
  const schoolReportMetrics = JSON.parse(schoolAgentReport[0][0].metrics_json);
  assert.ok(Number.isInteger(schoolReportMetrics.listings.active));
  assert.ok(Number.isSafeInteger(schoolReportMetrics.agent_proposals.pending));
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
        const event = eventResult?.[0]?.[0];
        if (!event || event.is_event !== true || event.school_id !== schoolId
            || (event.user_id !== moderatorId && !isSchoolReviewer)) return false;
        const registrationResult = await tx`SELECT status FROM fam_event_registrations
          WHERE event_id = ${eventId} AND user_id = ${userId} LIMIT 1;`;
        const registration = registrationResult?.[0]?.[0];
        if (!registration || registration.status !== 'pending') return false;
        await tx`UPDATE fam_event_registrations SET status = ${decision}
          WHERE event_id = ${eventId} AND user_id = ${userId};`;
        if (decision === 'rejected') {
          const occupancyResult = await tx`SELECT taken FROM fam_event_occupancy WHERE event_id = ${eventId} LIMIT 1;`;
          const taken = Number(occupancyResult?.[0]?.[0]?.taken ?? 0);
          await tx`UPSERT INTO fam_event_occupancy (event_id, taken)
            VALUES (${eventId}, Unwrap(CAST(${Math.max(0, taken - 1)} AS Uint32)));`;
        }
        return true;
      });
    },

    async getSchoolAgentMetrics(schoolId) {
      if (!schoolId) throw new TypeError('invalid agent report school');
      const count = async statement => Number((await statement)?.[0]?.[0]?.count ?? 0);
      const [active, fresh, safety, highSafety, deletion, suspensions, ideas] = await Promise.all([
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE school_id = ${schoolId} AND status = 'active';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE school_id = ${schoolId} AND created_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_safety_incidents WHERE school_id = ${schoolId} AND reviewed_at IS NULL;`),
        count(sql`SELECT COUNT(*) AS count FROM fam_safety_incidents WHERE school_id = ${schoolId} AND reviewed_at IS NULL AND severity = 'high';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_deletion_requests WHERE school_id = ${schoolId} AND status IN ('pending', 'processing');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_suspensions WHERE school_id = ${schoolId} AND status = 'active' AND expires_at > CurrentUtcTimestamp();`),
        count(sql`SELECT COUNT(*) AS count FROM fam_ideas WHERE school_id = ${schoolId} AND admin_status = 'new';`),
      ]);
      return { listings: { active, new_24h: fresh }, safety: { unreviewed: safety, high_unreviewed: highSafety },
        account_requests: { deletion_pending: deletion, active_suspensions: suspensions }, ideas: { awaiting_council: ideas } };
    },

    async countPendingSchoolAgentIdeas(schoolId) {
      if (!schoolId) throw new TypeError('invalid pending school proposals count');
      const rows = await sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE school_id = ${schoolId} AND status = 'pending';`;
      const count = Number(rows?.[0]?.[0]?.count ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid pending school proposals count');
      return count;
    },

    async saveSchoolAgentReport({ schoolId, date, summary, metrics }) {
      if (!schoolId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || typeof summary !== 'string' || !metrics) throw new TypeError('invalid school agent report');
      await sql`UPSERT INTO fam_agent_school_daily_reports (school_id, report_date, generated_at, summary, metrics_json)
        VALUES (${schoolId}, ${date}, CurrentUtcTimestamp(), ${summary}, ${JSON.stringify(metrics)});`;
    },

    async createSchoolAgentIdea({ id, schoolId, date, rule, count }) {
      if (!id || !schoolId || !date || !rule || !Number.isInteger(count) || count <= 0) throw new TypeError('invalid school agent idea');
      return sql.begin(async tx => {
        const prior = await tx`SELECT id FROM fam_agent_ideas WHERE school_id = ${schoolId} AND report_date = ${date} AND agent_rule_key = ${rule.key} LIMIT 1;`;
        if (prior?.[0]?.length) return false;
        await tx`INSERT INTO fam_agent_ideas
          (id, school_id, report_date, agent_rule_key, title, summary, benefit, complexity, risk, evidence_kind, evidence_summary, proposed_by, status, reviewed_by, reviewed_at, decision_note, created_at)
          VALUES (${id}, ${schoolId}, ${date}, ${rule.key}, ${rule.title}, ${rule.summary(count)}, ${rule.benefit}, ${rule.complexity || 'small'}, 'low', 'observed', ${rule.evidence(count)}, ${rule.proposedBy}, 'pending', NULL, NULL, NULL, CurrentUtcTimestamp());`;
        return true;
      });
    },

    async getGlobalAgentDailyMetrics() {
      const count = async statement => Number((await statement)?.[0]?.[0]?.count ?? 0);
      const [activeListings, newListings, unreviewedSafety, deletionRequests, activeSuspensions,
        pendingIdeas, approvedIdeas, rejectedIdeas] = await Promise.all([
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE status = 'active';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE created_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_safety_incidents WHERE reviewed_at IS NULL;`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_deletion_requests WHERE status IN ('pending', 'processing');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_suspensions WHERE status = 'active' AND expires_at > CurrentUtcTimestamp();`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'pending';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'approved';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'rejected';`),
      ]);
      return { listings: { active: activeListings, new_24h: newListings }, safety: { unreviewed: unreviewedSafety },
        account_requests: { deletion_pending: deletionRequests, active_suspensions: activeSuspensions },
        ideas: { pending: pendingIdeas, approved: approvedIdeas, rejected: rejectedIdeas } };
    },
  });

  assert.equal(await repo.createIdea({ user_id: 'synthetic-user', school_id: 'synthetic-school', text: 'Идея для школьной библиотеки' }), true);
  const ownIdeas = await repo.listOwnIdeas({ userId: 'synthetic-user', schoolId: 'synthetic-school', limit: 5 });
  assert.equal(ownIdeas.length, 1);
  assert.equal(ownIdeas[0].text, 'Идея для школьной библиотеки');
  assert.equal(await repo.deleteOwnIdea({ id: ownIdeas[0].id, userId: 'synthetic-user', schoolId: 'synthetic-school' }), true);
  await repo.createListing({ user_id: 'synthetic-user', school_id: 'synthetic-school', title: 'Букет к выпускному', description: 'Проверка фильтров', category: 'Подарки', price_text: 'Бесплатно', is_event: false, event_date: null, event_time: null, event_type: null, max_seats: 0, image_key: null, photo_status: null, status: 'pending' });
  assert.equal((await repo.getSchoolOptions()).length, 5);
  const publicLists = await repo.listListings({ schoolId: 'synthetic-school', viewerUserId: 'another-synthetic-user', limit: 10 });
  assert.equal(publicLists.length, 0, 'non-active listings stay private');
  await repo.updateListingStatus('synthetic-listing', 'synthetic-school', 'active');
  await repo.createListing({ user_id: 'synthetic-user', school_id: 'synthetic-school', title: 'Одобренный букет', description: 'Проверка доски', category: 'Подарки', price_text: 'Бесплатно', is_event: false, event_date: null, event_time: null, event_type: null, max_seats: 0, image_key: null, photo_status: null, status: 'active' });
  const ownLists = await repo.listListings({ schoolId: 'synthetic-school', viewerUserId: 'synthetic-user', limit: 10 });
  assert.equal(ownLists.length, 2);
  const anotherUserLists = await repo.listListings({ schoolId: 'synthetic-school', viewerUserId: 'another-synthetic-user', limit: 10 });
  assert.equal(anotherUserLists.length, 1, 'users cannot see another user pending listings');
  const anonymousLists = await repo.listListings({ schoolId: 'synthetic-school', viewerUserId: null, limit: 10 });
  assert.equal(anonymousLists.length, 1, 'anonymous users see only active school listings');
  const privatePhoto = await repo.getListingPhoto('synthetic-listing', 'synthetic-school', 'another-synthetic-user');
  assert.equal(privatePhoto, null);
  const schoolPhoto = await repo.getListingPhoto('synthetic-listing', 'synthetic-school', 'synthetic-user');
  assert.equal(schoolPhoto, null);
  await sql`INSERT INTO fam_favorites (user_id, listing_id) VALUES ('synthetic-user', 'synthetic-listing');`;
  const ownFavorites = await repo.listOwnFavoriteIds({ userId: 'synthetic-user', schoolId: 'synthetic-school', limit: 10 });
  assert.deepEqual(ownFavorites, ['synthetic-listing']);
  assert.equal(await repo.setOwnFavorite({ listingId: 'synthetic-listing', userId: 'synthetic-user', schoolId: 'synthetic-school', favorite: false }), true);
  assert.deepEqual(await repo.listOwnFavoriteIds({ userId: 'synthetic-user', schoolId: 'synthetic-school', limit: 10 }), []);
  await sql`INSERT INTO fam_ideas (id, school_id, user_id, text, admin_status, created_at)
    VALUES ('synthetic-idea-1', 'synthetic-school', 'synthetic-user', 'Синтетическая идея', 'new', CurrentUtcTimestamp());`;
  assert.deepEqual(await repo.countSchoolCouncilIdeas('synthetic-school'), { count: 1, image_count: 0 });
  const staffAnalytics = await repo.getSchoolStaffAnalytics('synthetic-school');
  assert.deepEqual(staffAnalytics, { total_ideas: 1, active_listings: 1, new_listings_24h: 1, pending_events: 0, active_events: 0, new_ideas_24h: 1, unresolved_safety_incidents: 0, unreviewed_profiles: 0, unreviewed_avatar_requests: 0, pending_events_by_day: [] });
  await sql`INSERT INTO fam_safety_incidents (id, school_id, reporter_user_id, category, severity, details, source_kind, created_at, reviewed_at, reviewed_by)
    VALUES ('synthetic-safety-1', 'synthetic-school', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'harassment', 'high', 'Синтетическая проверка', 'idea', CurrentUtcTimestamp(), NULL, NULL);`;
  const safetyQueue = await repo.listSafetyIncidents({ schoolId: 'synthetic-school', limit: 10 });
  assert.equal(safetyQueue.length, 1);
  assert.deepEqual(Object.keys(safetyQueue[0]).sort(), ['category', 'created_at', 'id', 'severity', 'source_kind'].sort());
  assert.equal(await repo.resolveSafetyIncident({ id: 'synthetic-safety-1', schoolId: 'wrong-school', reviewerUserId: '22222222-2222-4222-8222-222222222222', decisionNote: 'synthetic' }), false);
  assert.equal(await repo.resolveSafetyIncident({ id: 'synthetic-safety-1', schoolId: 'synthetic-school', reviewerUserId: '33333333-3333-4333-8333-333333333333', decisionNote: 'synthetic' }), true);
  const transitionToActive = await repo.transitionListingStatus({ id: 'synthetic-listing', schoolId: 'synthetic-school', status: 'active', moderatorId: '33333333-3333-4333-8333-333333333333' });
  assert.deepEqual(transitionToActive, { changed: true, photo_status: null });
  assert.equal(await repo.transitionListingStatus({ id: 'synthetic-listing', schoolId: 'synthetic-school', status: 'rejected', moderatorId: '33333333-3333-4333-8333-333333333333' }), true);
  const pulseResult = await repo.createSchoolAnnouncement({ schoolId: 'synthetic-school', actorUserId: '33333333-3333-4333-8333-333333333333', title: 'Синтетическое объявление', body: 'Техническая проверка', kind: 'announcement', options: [], closesAt: null });
  assert.ok(pulseResult?.id);
  assert.equal((await repo.listSchoolPulseItems({ schoolId: 'synthetic-school' })).length, 1);
  assert.equal(await repo.setSchoolAnnouncementStatus({ id: pulseResult.id, schoolId: 'synthetic-school', status: 'archived', actorUserId: '33333333-3333-4333-8333-333333333333' }), true);
  assert.deepEqual(await repo.listSchoolPulseResults({ id: pulseResult.id, schoolId: 'synthetic-school' }), { total: 0, options: [] });
  const poll = await repo.createSchoolAnnouncement({ schoolId: 'synthetic-school', actorUserId: '33333333-3333-4333-8333-433333333333', title: 'Синтетический опрос', body: 'Выберите вариант', kind: 'poll', options: ['Книга', 'Спорт'], closesAt: new Date(Date.now() + 86400000) });
  assert.ok(poll?.id);
  const vote = await repo.castSchoolPollVote({ announcementId: poll.id, schoolId: 'synthetic-school', userId: '11111111-1111-4111-8111-111111111111', optionIndex: 1 });
  assert.deepEqual(vote, { ok: true });
  assert.deepEqual(await repo.castSchoolPollVote({ announcementId: poll.id, schoolId: 'synthetic-school', userId: '11111111-1111-4111-8111-111111111111', optionIndex: 0 }), { ok: false, code: 'already_voted' });
  assert.deepEqual(await repo.listSchoolPollResults({ id: poll.id, schoolId: 'synthetic-school' }), { total: 1, options: [ { option_index: 0, text: 'Книга', votes: 0 }, { option_index: 1, text: 'Спорт', votes: 1 } ] });
  assert.equal(await repo.setSchoolAnnouncementStatus({ id: poll.id, schoolId: 'synthetic-school', status: 'archived', actorUserId: '33333333-3333-4333-8333-333333333333' }), true);
  assert.deepEqual(await repo.createSchoolAnnouncement({ schoolId: 'synthetic-school', actorUserId: '33333333-3333-4333-8333-333333333333', title: 'Дубликат закрытого опроса', body: 'Не должен пройти', kind: 'poll', options: ['Да', 'Нет'], closesAt: new Date(Date.now() + 86400000) }), { ok: false, code: 'active_poll_exists' });
  const schoolEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school', title: 'Синтетическое мероприятие', description: 'Для проверки регистрации', category: 'События', price_text: 'Бесплатно', is_event: true, event_date: '2026-12-20', event_time: '16:00', event_type: 'other', max_seats: 2, image_key: null, photo_status: null, status: 'active' });
  const externalEvent = await repo.createListing({ user_id: '44444444-4444-4444-8444-444444444444', school_id: 'lyceum_3', title: 'Чужое синтетическое мероприятие', description: 'Проверка изоляции', category: 'События', price_text: 'Бесплатно', is_event: true, event_date: '2026-12-20', event_time: '16:00', event_type: 'other', max_seats: 2, image_key: null, photo_status: null, status: 'active' });
  const schoolEvents = await listingsApi(apiRequest('GET', `/api/v1/events/${schoolEvent.id}/registrations`, 'synthetic-admin'));
  assert.equal(schoolEvents.status, 200);
  assert.deepEqual(schoolEvents.body, { registrations: [] });
  await sql`INSERT INTO fam_event_registrations (event_id, school_id, user_id, status, registered_at) VALUES
    (${schoolEvent.id}, 'synthetic-school', '11111111-1111-4111-8111-111111111111', 'approved', CurrentUtcTimestamp()),
    (${schoolEvent.id}, 'synthetic-school', '22222222-2222-4222-8222-222222222222', 'pending', CurrentUtcTimestamp()),
    (${schoolEvent.id}, 'synthetic-school', '66666666-6666-4666-8666-666666666666', 'pending', CurrentUtcTimestamp()),
    (${externalEvent.id}, 'lyceum_3', '55555555-5555-4555-8555-555555555555', 'pending', CurrentUtcTimestamp());`;
  const registrations = await listingsApi(apiRequest('GET', `/api/v1/events/${schoolEvent.id}/registrations`, 'synthetic-admin'));
  assert.equal(registrations.status, 200);
  assert.deepEqual(registrations.body.registrations.map(person => person.id), ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666']);
  assert.ok(registrations.body.registrations.every(person => person.school_id === undefined && person.email === undefined));
  assert.equal(await repo.transitionEventRegistration({ eventId: schoolEvent.id, schoolId: 'synthetic-school', userId: '22222222-2222-4222-8222-222222222222', moderatorId: '33333333-3333-4333-8333-333333333333', decision: 'approved' }), true);
  assert.equal(await repo.transitionEventRegistration({ eventId: schoolEvent.id, schoolId: 'synthetic-school', userId: '66666666-6666-4666-8666-666666666666', moderatorId: '33333333-3333-4333-8333-333333333333', decision: 'rejected' }), true);
  assert.equal(await repo.transitionEventRegistration({ eventId: schoolEvent.id, schoolId: 'lyceum_3', userId: '55555555-5555-4555-8555-555555555555', moderatorId: '33333333-3333-4333-8333-333333333333', decision: 'approved' }), false);
  const imageBuffer = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } }).webp().toBuffer();
  await repo.upsertListingPhoto({ listingId: 'synthetic-listing', schoolId: 'synthetic-school', ownerUserId: 'synthetic-user', bytes: imageBuffer, contentType: 'image/webp' });
  const storedPhoto = await repo.getListingPhoto('synthetic-listing', 'synthetic-school', 'synthetic-user');
  assert.equal(storedPhoto?.contentType, 'image/webp');
  assert.ok(storedPhoto?.bytes instanceof Uint8Array);
  const countPayload = await repo.getPublicCountPayload();
  assert.equal(countPayload.listings, 1);
  const idempotentPayload = await repo.getPublicCountPayload();
  assert.deepEqual(idempotentPayload, countPayload);
  const expectedNullKeys = new Set(['favorites', 'announcements', 'active_events', 'ideas']);
  const isolatedSchoolCounts = await repo.getPublicCountsForSchool('other-school');
  assert.deepEqual(new Set(Object.keys(isolatedSchoolCounts).filter(key => isolatedSchoolCounts[key] === null)), expectedNullKeys);
  assert.deepEqual(await listingsApi(apiRequest('GET', '/api/v1/public-counts?school_id=other-school', '')), { status: 200, body: { counts: isolatedSchoolCounts } });
  const mediaCountPayload = await repo.getPublicCountsForSchool('synthetic-school');
  assert.equal(mediaCountPayload.listings, null);
  const configuredSchoolCounts = await repo.getPublicCountsForSchool('synthetic-school', { schools: [{ id: 'synthetic-school' }], fallback: { listings: 99 } });
  assert.equal(configuredSchoolCounts.listings, 1);
  assert.equal(configuredSchoolCounts.favorites, 0);
  const notificationKeys = await repo.getNotificationKeys('synthetic-user');
  assert.ok(Array.isArray(notificationKeys));
  assert.equal(await repo.saveNotificationKeys('synthetic-user', ['release:synthetic']), true);
  assert.deepEqual(await repo.getNotificationKeys('synthetic-user'), ['release:synthetic']);
  assert.equal(await repo.saveNotificationKeys('synthetic-user', ['bad key']), false);
  assert.equal(await repo.getNotificationKeys('another-synthetic-user'), null);
  const secondOwnedObject = 'pending/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/synthetic-second.webp';
  accountMediaKeys.add(secondOwnedObject);
  await sql`INSERT INTO fam_pending_media (object_key, user_id, created_at, expires_at, status, linked_listing_id)
    VALUES (${secondOwnedObject}, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', CurrentUtcTimestamp(), CurrentUtcTimestamp() + Interval('P7D'), 'pending', NULL);`;
  const accountDeletion = createAccountDeletionRecoveryOperation({
    repository: repo,
    pendingImages: {
      ...syntheticPendingImages,
      listUserObjects: async userId => [...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)),
      listAccountObjects: async (userId, ownedKeys = []) => [...new Set([
        ...[...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)), ...ownedKeys,
      ])],
      delete: async key => { deletedMediaKeys.push(key); accountMediaKeys.delete(key); },
    },
    now: () => new Date(),
  });
  const deletionToken = 'synthetic-account-delete-claim';
  await sql`INSERT INTO fam_account_deletion_jobs (id, user_id, actor_role, status, attempts, created_at, updated_at,
      request_id, claim_token, claimed_at, claim_expires_at, cleanup_started_at, last_error_code)
    VALUES ('synthetic-delete-job', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'student', 'processing', 1,
      CurrentUtcTimestamp(), CurrentUtcTimestamp(), NULL, ${deletionToken}, CurrentUtcTimestamp(), CurrentUtcTimestamp() + Interval('PT15M'), NULL, NULL);`;
  assert.deepEqual(await accountDeletion({ id: 'synthetic-delete-job', user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', claim_token: deletionToken }), { ok: true, removed: 1 });
  assert.deepEqual(deletedMediaKeys, [secondOwnedObject]);
  assert.equal(await repo.getUserProfileById('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), null);
  const wrongScopedRecoveryKey = 'pending/another-account/synthetic.webp';
  const incompleteRecovery = createAccountDeletionRecoveryOperation({
    repository: repo,
    pendingImages: { listUserObjects: async () => [wrongScopedRecoveryKey], delete: async () => assert.fail('unexpected unscoped object delete'), },
    now: () => new Date(),
  });
  assert.deepEqual(await incompleteRecovery({ id: 'synthetic-delete-job', user_id: 'synthetic-user', claim_token: deletionToken }), { ok: false, retry: true, code: 'invalid_inventory' });
  const createdProfile = await repo.createUserProfile({ issuer: 'https://issuer.synthetic', subject: 'subject-new', schoolId: 'synthetic-school', role: 'student', firstName: 'Тест', lastName: 'Регистрация' });
  assert.equal(createdProfile, 'subject-new');
  const pendingRegistration = await repo.createUserProfile({ issuer: 'https://issuer.synthetic', subject: 'subject-new-staff', schoolId: 'synthetic-school', role: 'student', firstName: 'Тест', lastName: 'Сотрудник', personType: 'staff', staffPosition: 'учитель' });
  assert.equal(pendingRegistration, 'subject-new-staff');
  assert.deepEqual(await repo.getUserProfile('https://issuer.synthetic', 'subject-new-staff'), { active: false, id: 'subject-new-staff', role: 'student', school_id: 'synthetic-school', first_name: 'Тест', last_name: 'Сотрудник', class_name: null, city: null, avatar_url: null, person_type: 'staff', staff_position: 'учитель', staff_verification_status: 'pending' });
  const privacyRawQuestion = 'Вопрос с телефоном +7 916 555-12-34';
  assert.deepEqual(await createListingsApi({ authenticate, resolveActor, repository: repo, safetyKey: 'local-ci-only-synthetic-safety-key-over-32-bytes' })(apiRequest('POST', '/api/v1/safety/anonymous', '', { category: 'harassment', details: privacyRawQuestion })), { status: 202, body: { ok: true, triage: 'manual_review' } });
  const rawPrivacyStored = await sql`SELECT details, details_hash FROM fam_safety_incidents WHERE school_id = 'synthetic-school' ORDER BY created_at DESC LIMIT 1;`;
  assert.notEqual(rawPrivacyStored[0][0].details, privacyRawQuestion);
  assert.match(rawPrivacyStored[0][0].details, /^sha256:/);
  assert.match(rawPrivacyStored[0][0].details_hash, /^[a-f0-9]{64}$/);
  const selfDeletion = await listingsApi(apiRequest('POST', '/api/v1/account/deletion/request', 'synthetic-registrant', { confirmation: 'УДАЛИТЬ АККАУНТ FAM', reason: 'Тестирование удаления синтетической учётной записи' }));
  assert.equal(selfDeletion.status, 202);
  const savedSelfDeletion = await sql`SELECT user_id, status FROM fam_account_deletion_requests WHERE user_id = '11111111-1111-4111-8111-111111111111' LIMIT 1;`;
  assert.deepEqual(savedSelfDeletion[0][0], { user_id: '11111111-1111-4111-8111-111111111111', status: 'pending' });
  const openDeletionRequest = await repo.createAccountDeletionRequest({ userId: '11111111-1111-4111-8111-111111111111', schoolId: 'synthetic-school', reason: 'Проверка синтетической очереди' });
  assert.ok(openDeletionRequest?.id);
  const openDeletion = await repo.beginAccountDeletion({ requestId: openDeletionRequest.id, schoolId: 'synthetic-school', actorUserId: '33333333-3333-4333-8333-333333333333', actorRole: 'school_admin', actorAuthenticatedAt: Math.floor(Date.now() / 1000), now: new Date(), claimToken: 'synthetic-delete-claim' });
  assert.equal(openDeletion?.ok, true);
  assert.ok(openDeletion?.request?.claim_token);
  assert.equal(await repo.finishAccountDeletion({ jobId: openDeletion.request.id, claimToken: openDeletion.request.claim_token }), true);
  const scheduledQueue = createYdbAgentTaskQueue(sql, { createId: () => 'synthetic-scheduled-queue-task' });
  const scheduledWorker = createSafeAgentTaskWorker({
    repository: scheduledQueue,
    handlers: {
      system_health_check: createSystemHealthTaskHandler({
        checkHealth: async () => ({ ok: true, checks: { auth: true, ydb: true, timers: true } }),
      }),
      daily_report_digest: createOrchestratorDailyDigest({ repository: repo, clock: () => new Date('2026-11-22T04:00:00.000Z') }),
      site_error_digest: createSiteErrorDigest({ repository: repo, clock: () => new Date('2026-11-22T04:30:00.000Z') }),
    },
    now: () => new Date('2026-11-22T03:40:00.000Z'),
  });
  const scheduledRunner = createScheduledSafeAgentRunner({
    enqueue: scheduledQueue.enqueue.bind(scheduledQueue),
    runWorker: scheduledWorker,
    allowedKinds: ['system_health_check', 'daily_report_digest', 'site_error_digest'],
  });
  for (const [kind, slot] of [
    ['system_health_check', '2026-11-22T03:40:00.000Z'],
    ['daily_report_digest', '2026-11-22T04:00:00.000Z'],
    ['site_error_digest', '2026-11-22T04:30:00.000Z'],
  ]) {
    const scheduledResult = await scheduledRunner({ kind, at: new Date(slot) });
    assert.equal(scheduledResult.enqueued, 1, `${kind} should create a synthetic scheduled task`);
    assert.equal(scheduledResult.run?.processed, 1, `${kind} should exercise the durable worker lease and handler`);
    const scheduleRows = await sql`SELECT status, attempt_count FROM fam_agent_task_queue WHERE id = 'synthetic-scheduled-queue-task' AND task_kind = ${kind} LIMIT 1;`;
    assert.equal(scheduleRows?.[0]?.[0]?.status, 'completed', `${kind} should finish only after its registered safe handler succeeds`);
    assert.equal(scheduleRows?.[0]?.[0]?.attempt_count, 1, `${kind} should be delivered exactly once in the disposable schedule integration`);
  }
} finally {
  await syntheticPendingImages?.close().catch(() => {});
  await driver.close();
}
