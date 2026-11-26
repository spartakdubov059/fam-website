import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
import { getSiteErrorDigestSlot } from '../services/site-error-digest.mjs';

test('site error digest slot uses latest due hourly minute-30 slot and rejects invalid dates', () => {
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:29:59.999Z')), '2026-11-18T05:30');
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:30:00.000Z')), '2026-11-18T06:30');
  assert.throws(() => getSiteErrorDigestSlot(new Date('invalid')), /invalid site error digest time/);
});

test('own listing summaries are scoped to owner and omit database ownership and storage keys', async () => {
  let query; let values;
  const repository = createYdbListingsRepository((strings, ...bound) => {
    query = strings.join('?'); values = bound;
    return Promise.resolve([[{ id: 'listing-a', title: 'Синтетика', description: 'Описание', category: 'Учёба',
      price_text: 'Бесплатно', status: 'pending', photo_status: 'pending', created_at: '2026-01-01',
      image_key: 'private/key', user_id: 'private-owner', school_id: 'private-school' }]]);
  });
  const result = await repository.listOwnListingSummaries('owner-a');
  assert.deepEqual(values, ['owner-a']);
  assert.match(query, /WHERE user_id = \?/);
  assert.match(query, /ORDER BY created_at DESC LIMIT 100/);
  assert.equal(result[0].status, 'pending');
  assert.equal(result[0].photo_status, 'pending');
  assert.equal(Object.hasOwn(result[0], 'image_key'), false);
  assert.equal(Object.hasOwn(result[0], 'user_id'), false);
  assert.equal(Object.hasOwn(result[0], 'school_id'), false);
});

test('active listing feed requires a school scope in the YDB query', async () => {
  let query; let values;
  const repository = createYdbListingsRepository((strings, ...bound) => {
    query = strings.join('?'); values = bound; return Promise.resolve([[]]);
  });
  assert.deepEqual(await repository.listActiveListings('school-a'), []);
  assert.deepEqual(values, ['school-a']);
  assert.match(query, /WHERE school_id = \? AND status = 'active'/);
  await assert.rejects(repository.listActiveListings(''), TypeError);
});

test('school notification listing query excludes the active user and projects no ownership fields', async () => {
  let query; let values;
  const repository = createYdbListingsRepository((strings, ...bound) => {
    query = strings.join('?'); values = bound;
    return Promise.resolve([[{ id: 'listing-a', title: 'Новость', is_event: true, created_at: '2026-11-22T10:00:00Z' }]]);
  });
  const ownerId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(await repository.listRecentSchoolNotificationListings('school-a', ownerId), [
    { id: 'listing-a', title: 'Новость', is_event: true, created_at: '2026-11-22T10:00:00Z' },
  ]);
  assert.deepEqual(values, ['school-a', ownerId]);
  assert.match(query, /school_id = \? AND user_id != \? AND status = 'active'/);
  assert.match(query, /Interval\('P14D'\)/);
  assert.match(query, /LIMIT 8/);
  assert.doesNotMatch(query, /image_key|email/);
  await assert.rejects(repository.listRecentSchoolNotificationListings('', ownerId), TypeError);
  await assert.rejects(repository.listRecentSchoolNotificationListings('school-a', 'invalid'), TypeError);
});

test('school role review queue joins only the same-school profile projection', async () => {
  let query;
  const row = { request_id: 'request-a', user_id: '11111111-1111-4111-8111-1234567890ab', requested_role: 'council_member',
    status: 'pending', first_name: 'Тест', last_name: 'Ученик', class_name: '8А' };
  const repository = createYdbListingsRepository(strings => { query = strings.join('?'); return Promise.resolve([[row]]); });
  assert.deepEqual(await repository.listPendingSchoolRoleRequests('school-a'), [row]);
  assert.match(query, /r\.request_id AS request_id, r\.user_id AS user_id/);
  assert.match(query, /p\.first_name AS first_name, p\.last_name AS last_name, p\.class_name AS class_name/);
  assert.match(query, /INNER JOIN fam_user_profiles AS p ON p\.user_id = r\.user_id AND p\.school_id = r\.school_id/);
  assert.match(query, /r\.school_id = \?/);
  assert.match(query, /r\.status IN \('pending', 'reviewing'\)/);
  assert.match(query, /LIMIT 50/);
});

test('school pulse merges same-school open-entry events ahead of notices without exposing listing ownership', async () => {
  const calls = [];
  const announcement = { id: 'notice-a', title: 'Школьная новость', body: 'Собрание в пятницу', kind: 'news',
    published_at: new Date('2026-03-01T10:00:00Z'), event_starts_at: null, author_id: 'private-author' };
  const events = [
    { id: 'event-old', title: 'Старое открытое событие', body: 'Описание события', published_at: new Date('2026-01-01T10:00:00Z'),
      event_date: '2099-12-30', event_time: '10:00', user_id: 'private-user', image_key: 'private-key' },
    { id: 'event-new', title: 'Новое открытое событие', body: 'Новое описание', published_at: new Date('2026-02-01T10:00:00Z'),
      event_date: '2099-12-31', event_time: '11:00', user_id: 'private-user', image_key: 'private-key' },
  ];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_school_announcements')) return [[announcement]];
    if (text.includes('FROM fam_listings')) return [[...events]];
    if (text.includes('FROM fam_school_polls')) return [[]];
    throw new Error('unexpected school pulse query');
  };

  const pulse = await createYdbListingsRepository(sql).listSchoolPulse('school-a', 'student-a');
  assert.deepEqual(pulse.announcements.map(row => row.id), ['event-new', 'event-old', 'notice-a'],
    'open-entry events are prioritized and ordered by publication time');
  assert.equal(pulse.announcements[0].kind, 'open_event');
  assert.equal(pulse.announcements[0].event_date, '2099-12-31');
  assert.equal(pulse.announcements[0].event_time, '11:00');
  assert.equal(pulse.announcements[0].event_starts_at, null);
  assert.equal(Object.hasOwn(pulse.announcements[0], 'user_id'), false);
  assert.equal(Object.hasOwn(pulse.announcements[0], 'image_key'), false);
  assert.equal(Object.hasOwn(pulse.announcements[2], 'author_id'), false);

  const query = calls.find(call => call.text.includes('FROM fam_listings'));
  assert.ok(query.values.includes('school-a'));
  assert.match(query.text, /status = 'active' AND is_event = true/);
  assert.match(query.text, /max_seats = 0/);
  assert.match(query.text, /CAST\(event_date AS Date\) >= CurrentUtcDate\(\)/);
  assert.match(query.text, /Unicode::Substring\(description, 0, 450\)/);
  assert.match(query.text, /LIMIT 6/);
  assert.doesNotMatch(query.text, /user_id|image_key|author_id/);
});

test('site error digest aggregation reads only bounded aggregate counters and returns top categories', async () => {
  let query;
  const rows = [
    { event_code: 'js_runtime', page_area: 'other', event_count: 4, last_hour: true },
    { event_code: 'database_request_failed', page_area: 'database', event_count: 2, last_hour: false },
    { event_code: 'js_runtime', page_area: 'other', event_count: 3, last_hour: false },
  ];
  const repo = createYdbListingsRepository((strings) => { query = strings.join('?'); return Promise.resolve([rows]); });
  assert.deepEqual(await repo.getSiteErrorDigestMetrics(), {
    total_events_24h: 9, events_last_hour: 4,
    events: [{ event_code: 'js_runtime', page_area: 'other', occurrences: 7 },
      { event_code: 'database_request_failed', page_area: 'database', occurrences: 2 }],
  });
  assert.match(query, /Interval\('PT24H'\)/);
  assert.match(query, /Interval\('PT1H'\)/);
  assert.match(query, /LIMIT 1000/);
  assert.doesNotMatch(query, /body|text|url|user_id|email|stack/i);
});

test('site error digest repository rejects slots outside the final hourly source schedule before database access', async () => {
  let reads = 0;
  const repo = createYdbListingsRepository(async () => { reads++; return [[]]; });
  await assert.rejects(repo.enqueueSiteErrorDigestTask('2026-11-18T06:15'), /invalid site error digest slot/);
  assert.equal(reads, 0);
});

test('RU background queue health reads only aggregate statuses, expired leases and queue age', async () => {
  const calls = [];
  const now = () => Date.parse('2026-11-18T12:00:00.000Z');
  const sql = strings => {
    const text = strings.join('?'); calls.push(text);
    if (text.includes('GROUP BY status')) return Promise.resolve([[{ status: 'queued', count: 2 }, { status: 'claimed', count: 1 }]]);
    if (text.includes('lease_expires_at')) return Promise.resolve([[{ count: 1 }]]);
    if (text.includes("status IN ('failed', 'blocked')")) return Promise.resolve([[{ count: 3 }]]);
    if (text.includes('MIN(available_at)')) return Promise.resolve([[{ oldest_queued_at: new Date('2026-11-18T11:40:00.000Z') }]]);
    throw new Error('unexpected query');
  };
  const report = await createYdbListingsRepository(sql).getRuBackgroundQueueHealth(now);
  assert.equal(report.checked_at, '2026-11-18T12:00:00.000Z');
  assert.equal(report.content_read, false);
  assert.deepEqual(report.queues.daily_reports, { statuses: { queued: 2, claimed: 1, completed: 0, blocked: 0, failed: 0 }, expired_leases: 1,
    failed_or_blocked_24h: 3, oldest_queued_age_minutes: 20 });
  assert.deepEqual(report.queues.site_error_digests, report.queues.daily_reports);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(query => /COUNT\(\*\)|MIN\(available_at\)/.test(query)));
  assert.ok(calls.every(query => !/payload|summary|user_id|text|email|body/i.test(query)));
});

test('latest completed site error digest is projected from bounded aggregate fields only', async () => {
  const slot = '2026-11-18T06:30';
  const summary = 'Проверка ошибок FAM: агрегированные данные.';
  const metrics = { total_events_24h: 9, events_last_hour: 2,
    events: [{ event_code: 'js_runtime', page_area: 'other', occurrences: 9 }] };
  const repo = createYdbListingsRepository(async () => [[{ digest_slot: slot,
    generated_at: new Date('2026-11-18T06:31:00.000Z'), metrics_json: JSON.stringify(metrics), summary }]]);
  assert.deepEqual(await repo.getLatestSiteErrorDigest(), { digest_slot: slot,
    generated_at: new Date('2026-11-18T06:31:00.000Z'), metrics, summary });
});
test('technical alert query applies the source thresholds and derives severity without raw diagnostics', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ event_code: 'database_request_failed', page_area: 'database', event_count: 3,
      hour_bucket: new Date('2026-11-15T12:00:00Z') }]]);
  });
  const alerts = await repo.listSiteErrorAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  assert.match(query.text, /Interval\('PT24H'\)/);
  assert.match(query.text, /event_count >= 3/);
  assert.match(query.text, /event_count >= 10/);
  assert.match(query.text, /LIMIT 20/);
  assert.doesNotMatch(query.text, /message|description|user_id|email/i);
});

test('notification state queries and writes are scoped to one verified user', async () => {
  const operations = [];
  const tx = async (strings, ...values) => { operations.push({ text: strings.join('?'), values }); return [[]]; };
  const sql = Object.assign(async (strings, ...values) => {
    operations.push({ text: strings.join('?'), values });
    return [[{ notification_key: 'release:test', read_at: new Date('2026-11-17T00:00:00Z') }]];
  }, { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  const states = await repo.listNotificationReadStates('verified-user');
  assert.equal(states[0].notification_key, 'release:test');
  assert.ok(operations[0].values.includes('verified-user'));
  assert.match(operations[0].text, /ORDER BY notification_key LIMIT 10001/);
  await repo.saveNotificationReadStates('verified-user', ['release:test', 'dismissed:release:test']);
  const writes = operations.slice(1);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => write.text.includes('UPSERT INTO fam_notification_reads') && write.values.includes('verified-user')));
  await assert.rejects(repo.saveNotificationReadStates('verified-user', Array(101).fill('key')), TypeError);
});

test('active suspension lookup is bounded to the actor school and ignores expired records', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ reason: 'synthetic policy violation', duration_hours: 24, expires_at: '2099-01-01T00:00:00Z' }]]);
  });
  const suspension = await repo.getActiveAccountSuspension('school-a', 'student-a');
  assert.equal(suspension.reason, 'synthetic policy violation');
  assert.ok(query.values.includes('school-a'));
  assert.ok(query.values.includes('student-a'));
  assert.match(query.text, /status = 'active'/);
  assert.match(query.text, /expires_at > CurrentUtcTimestamp\(\)/);
  assert.match(query.text, /LIMIT 1/);
  assert.doesNotMatch(query.text, /SELECT \*/);
  await assert.rejects(repo.getActiveAccountSuspension('', 'student-a'), TypeError);
});

test('active suspension list is school-bound, time-filtered, and bounded', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => { query = { text: strings.join('?'), values }; return Promise.resolve([[{ target_id: 'student-a' }]]); });
  const rows = await repo.listActiveAccountSuspensions('school-a');
  assert.deepEqual(rows, [{ target_id: 'student-a' }]);
  assert.ok(query.values.includes('school-a'));
  assert.match(query.text, /school_id = \?/);
  assert.match(query.text, /expires_at > CurrentUtcTimestamp\(\)/);
  assert.match(query.text, /LIMIT 100/);
});
test('safety report groups are bounded, sanitized, school-scoped and acknowledge atomically', async () => {
  const fingerprint = 'a'.repeat(64); const calls = [];
  const now = Date.parse('2026-05-03T00:00:00.000Z');
  const incidents = [0, 1, 2].map((offset, i) => ({ pair_fingerprint: fingerprint, source_kind: 'message', category: 'targeted_harassment',
    severity: i === 0 ? 'medium' : 'high', created_at: new Date(now - offset * 60_000), actor_id: '11111111-1111-4111-8111-111111111111',
    target_id: '22222222-2222-4222-8222-222222222222', source_origin: 'fam.example.ru', evidence_excerpt: 'sanitized sample' }));
  let acknowledged = false;
  const sql = Object.assign(async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT pair_fingerprint, source_kind')) return [[...incidents]];
    if (text.includes('FROM fam_user_profiles')) return [[{ id: values.at(-1), role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А' }]];
    return [[]];
  }, { begin: async callback => callback(async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT incident_id')) return acknowledged ? [[]] : [[{ incident_id: 'incident-1' }, { incident_id: 'incident-2' }]];
    if (text.includes('UPDATE fam_safety_incidents')) { acknowledged = true; return [[]]; }
    return [[]];
  }) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.listSchoolSafetyReports('school-a');
  assert.equal(result.period_days, 30);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].occurrences, 3);
  assert.equal(result.reports[0].severity, 'high');
  assert.equal(result.reports[0].actor.first_name, 'Тест');
  assert.equal(Object.hasOwn(result.reports[0].actor, 'subject'), false);
  assert.ok(calls.some(call => call.text.includes("Interval('P90D')") && call.values.includes('school-a')));
  assert.equal(await repo.acknowledgeSchoolSafetyReport({ schoolId: 'school-a', reviewerId: 'admin-a', fingerprint, category: 'targeted_harassment', sourceKind: 'message' }), true);
  assert.equal(await repo.acknowledgeSchoolSafetyReport({ schoolId: 'school-b', reviewerId: 'admin-b', fingerprint, category: 'targeted_harassment', sourceKind: 'message' }), false);
  assert.ok(calls.some(call => call.text.includes('reviewed_by = ?') && call.values.includes('school-a')));
  await assert.rejects(repo.acknowledgeSchoolSafetyReport({ schoolId: 'school-a', reviewerId: 'admin-a', fingerprint: 'bad', category: 'targeted_harassment', sourceKind: 'message' }), TypeError);
});

test('safety signal writer sanitizes evidence excerpt before binding it to YDB', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => { query = { text: strings.join('?'), values }; return Promise.resolve([[]]); });
  assert.equal(await repo.recordSafetySignal({ schoolId: 'school-a', fingerprint: 'a'.repeat(64), sourceKind: 'message',
    category: 'threat_or_intimidation', severity: 'high', actorId: '11111111-1111-4111-8111-111111111111',
    targetId: '22222222-2222-4222-8222-222222222222', sourceOrigin: 'messages',
    evidenceExcerpt: 'текст угрозы test@example.ru https://example.test +7 999 123-45-67' }), true);
  assert.match(query.text, /INSERT INTO fam_safety_incidents/);
  assert.match(query.text, /evidence_excerpt\)\s+VALUES/);
  assert.ok(query.values.includes('school-a') && query.values.includes('a'.repeat(64)));
  assert.ok(query.values.includes('текст угрозы [почта скрыта] [ссылка скрыта] [номер скрыт]'));
  assert.equal(query.values.includes('test@example.ru'), false);
  assert.equal(query.values.includes('https://example.test'), false);
  assert.equal(query.values.includes('+7 999 123-45-67'), false);
  assert.equal(query.text.includes('текст угрозы'), false, 'excerpt is bound as data, not embedded into SQL');
  assert.ok(query.text.includes('NULL'), 'review fields remain null');
  await repo.recordSafetySignal({ schoolId: 'school-a', fingerprint: 'b'.repeat(64), sourceKind: 'image',
    category: 'unsafe_image', severity: 'high', actorId: '11111111-1111-4111-8111-111111111111',
    sourceOrigin: 'images', evidenceExcerpt: 'image source must never retain accompanying text' });
  assert.ok(query.values.includes(null), 'image incident evidence is always null');
  assert.equal(query.values.includes('image source must never retain accompanying text'), false);
  await assert.rejects(repo.recordSafetySignal({ schoolId: 'school-a', fingerprint: 'bad', sourceKind: 'message',
    category: 'threat_or_intimidation', severity: 'high', actorId: '11111111-1111-4111-8111-111111111111', sourceOrigin: 'messages' }), TypeError);
});

test('school admin overview binds every projection to its school and returns no external identity fields', async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return [[{ id: 'synthetic-user', role: 'student', first_name: 'Тест' }]];
    if (text.includes('FROM fam_listings')) return [[{ id: 'listing-id', user_id: 'synthetic-user', status: 'pending', photo_status: 'pending' }]];
    if (text.includes('FROM fam_school_admin_audit')) return [[{ actor_id: 'admin-a', target_id: 'student-a', action: 'role_revoked', created_at: '2026-01-01T00:00:00Z' }]];
    if (text.includes('FROM fam_account_suspension_audit')) return [[]];
    if (text.includes('FROM fam_school_content_audit')) return [[]];
    if (text.includes('FROM fam_account_deletion_requests')) return [[]];
    if (text.includes('FROM fam_account_suspensions')) return [[]];
    return [[]];
  };
  const overview = await createYdbListingsRepository(sql).getSchoolAdminOverview('school-a');
  assert.equal(overview.users[0].id, 'synthetic-user');
  assert.equal(overview.listings[0].moderation_status, 'pending');
  assert.equal(overview.audit[0].actor, 'admin-a');
  assert.equal(Object.hasOwn(overview.users[0], 'subject'), false);
  assert.equal(calls.length, 7);
  for (const call of calls) assert.ok(call.values.includes('school-a'));
  await assert.rejects(createYdbListingsRepository(sql).getSchoolAdminOverview(''), TypeError);
});

test('idea image keys are atomically linked to the synthetic idea from only their uploader', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_pending_media')) return [[{ status: 'pending' }]];
    return [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const key = `pending/${userId}/11111111-1111-4111-8111-111111111111.webp`;
  const result = await repo.createIdea({ user_id: userId, school_id: 'school-a', text: 'Тестовая идея',
    image_keys: [key], image_status: 'pending', ai_status: 'approved', ai_summary: 'Тест', ai_reason: '', admin_status: 'new' });
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.ok(calls.some(call => call.text.includes('INSERT INTO fam_ideas') && !call.text.includes('image_keys')));
  assert.ok(calls.some(call => call.text.includes('INSERT INTO fam_idea_images') && call.values.includes(key)));
  assert.ok(calls.some(call => call.text.includes("SET status = 'linked'") && call.values.includes(key) && call.values.includes(userId)));
});

test('idea image linkage rejects an object owned by another account before inserting the idea', async () => {
  let inserted = false;
  const tx = async (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('FROM fam_pending_media')) return values.includes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') ? [[]] : [[{ status: 'pending' }]];
    if (text.includes('INSERT INTO fam_ideas')) inserted = true;
    return [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  const key = 'pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111.webp';
  await assert.rejects(repo.createIdea({ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', school_id: 'school-a',
    text: 'Чужая картинка', image_keys: [key], image_status: 'pending', ai_status: 'approved', admin_status: 'new' }), /idea image unavailable/);
  assert.equal(inserted, false);
});

test('school idea review listing scopes pending text to admins and approved ideas to council', async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_ideas')) return [[{ id: 'idea-a', school_id: 'school-a', user_id: 'student-a', text: 'Синтетическая идея', image_status: 'pending', ai_status: 'approved' }]];
    if (text.includes('FROM fam_idea_images')) return [[{ object_key: 'pending/user-id/photo.webp' }]];
    return [[]];
  };
  const reviewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const repo = createYdbListingsRepository(sql);
  const councilIdeas = await repo.listPendingSchoolIdeas('school-a', reviewerId, 'council_member');
  assert.deepEqual(councilIdeas, [{ id: 'idea-a', school_id: 'school-a', text: 'Синтетическая идея', ai_status: 'approved',
    image_status: 'pending', image_keys: ['pending/user-id/photo.webp'] }]);
  const councilQueue = calls.find(call => call.text.includes('FROM fam_ideas'));
  assert.match(councilQueue.text, /ai_status = 'approved'/);
  assert.match(councilQueue.text, /user_id != \?/);
  assert.ok(councilQueue.values.includes('school-a'));
  assert.ok(councilQueue.values.includes(reviewerId));
  assert.ok(calls.some(call => call.text.includes('FROM fam_idea_images') && call.values.includes('idea-a')));
  const imageQuery = calls.find(call => call.text.includes('FROM fam_idea_images'));
  assert.match(imageQuery.text, /user_id = \?/);
  assert.match(imageQuery.text, /school_id = \?/);
  assert.deepEqual(imageQuery.values, ['idea-a', 'student-a', 'school-a']);
  assert.equal(Object.hasOwn(councilIdeas[0], 'user_id'), false, 'private owner id is not exposed to school reviewers');
  calls.length = 0;
  await repo.listPendingSchoolIdeas('school-a', reviewerId, 'school_admin');
  const adminQueue = calls.find(call => call.text.includes('FROM fam_ideas'));
  assert.match(adminQueue.text, /ai_status != 'rejected'/, 'school admins retain access to AI-pending ideas for adult review');
  assert.doesNotMatch(adminQueue.text, /ai_status = 'approved'/);
  await assert.rejects(repo.listPendingSchoolIdeas('school-a', reviewerId, 'student'), TypeError);
});

test('school idea review queue omits media keys from a row linked to another school or owner', async () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const foreignOwnerId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_ideas')) return [[{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', user_id: ownerId,
      text: 'Синтетическая идея', image_status: 'pending', ai_status: 'approved',
    }]];
    if (text.includes('FROM fam_idea_images')) {
      assert.deepEqual(values, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerId, 'school-a']);
      const corruptImageRow = { user_id: foreignOwnerId, school_id: 'school-b', object_key: `pending/${foreignOwnerId}/photo.webp` };
      return corruptImageRow.user_id === values[1] && corruptImageRow.school_id === values[2] ? [[corruptImageRow]] : [[]];
    }
    return [[]];
  };
  const ideas = await createYdbListingsRepository(sql).listPendingSchoolIdeas(
    'school-a', '33333333-3333-4333-8333-333333333333', 'school_admin');
  assert.deepEqual(ideas[0].image_keys, []);
  assert.equal(Object.hasOwn(ideas[0], 'user_id'), false);
  assert.ok(calls.some(call => call.text.includes('FROM fam_idea_images')));
});

test('council cannot decide pending idea text or moderate its photo before AI approval', async () => {
  const calls = [];
  const tx = async strings => {
    const text = strings.join('?'); calls.push(text);
    if (text.includes('FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'council_member', active: true }]];
    if (text.includes('FROM fam_ideas')) return [[{ user_id: 'student-id', ai_status: 'pending', image_status: 'pending' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const input = { ideaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schoolId: 'school-a',
    reviewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', decision: 'reject' };
  assert.equal(await repo.reviewSchoolIdeaText(input), false);
  assert.equal(await repo.reviewSchoolIdeaImages(input), false);
  assert.equal(calls.filter(text => text.includes('FROM fam_ideas')).length, 1,
    'text review is denied from the database-backed council role before reading the idea');
  assert.ok(!calls.some(text => text.includes('FROM fam_idea_images')),
    'council cannot enumerate photos attached to AI-pending text');
});

test('school admin can review AI-pending school idea text without storing its body in the audit', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
    if (text.includes('FROM fam_ideas')) return [[{ user_id: 'student-id', ai_status: 'pending', image_status: 'pending' }]];
    if (text.includes('FROM fam_idea_images')) return [[{ image_index: 0, object_key: 'pending/student-id/photo.webp' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.reviewSchoolIdeaText({ ideaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schoolId: 'school-a', reviewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', decision: 'reject' }), true);
  const updates = calls.filter(call => call.text.includes('UPDATE fam_pending_media') || call.text.includes('UPDATE fam_ideas'));
  assert.equal(updates.length, 2);
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_idea_images')));
  const imageSelect = calls.find(call => call.text.includes('FROM fam_idea_images'));
  assert.match(imageSelect.text, /user_id = \?/);
  assert.match(imageSelect.text, /school_id = \?/);
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_idea_images')
    && call.values.includes('student-id') && call.values.includes('school-a')));
  const audit = calls.find(call => call.text.includes('INSERT INTO fam_school_content_audit'));
  assert.ok(audit);
  assert.ok(audit.values.includes('idea_text_rejected'));
  assert.ok(!audit.values.includes('Синтетическая идея'));
});

test('school idea image review cannot approve or delete an image row linked to another owner or school', async () => {
  const ideaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const foreignOwnerId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
    if (text.includes('FROM fam_ideas')) return [[{ user_id: ownerId, image_status: 'pending', ai_status: 'approved' }]];
    if (text.includes('FROM fam_idea_images')) {
      assert.deepEqual(values, [ideaId, ownerId, 'school-a']);
      const corruptImageRow = { user_id: foreignOwnerId, school_id: 'school-b', image_index: 0,
        object_key: `pending/${foreignOwnerId}/photo.webp` };
      return corruptImageRow.user_id === values[1] && corruptImageRow.school_id === values[2] ? [[corruptImageRow]] : [[]];
    }
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const approved = await createYdbListingsRepository(sql).reviewSchoolIdeaImages({
    ideaId, schoolId: 'school-a', reviewerId: '33333333-3333-4333-8333-333333333333', decision: 'approve',
  });
  assert.equal(approved, false);
  assert.equal(calls.some(call => call.text.includes('UPDATE fam_ideas')), false);
  assert.equal(calls.some(call => call.text.includes('DELETE FROM fam_idea_images')), false);
});

test('school idea workflow lists only approved same-school ideas and permits only valid status transitions', async () => {
  const calls = [];
  const sql = async (strings, ...values) => { calls.push({ text: strings.join('?'), values }); return [[{ id: 'idea-a', text: 'Synthetic idea', admin_status: 'new', is_own: true }]]; };
  const listed = await createYdbListingsRepository(sql).listSchoolIdeaWorkflow('school-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.deepEqual(listed, [{ id: 'idea-a', text: 'Synthetic idea', admin_status: 'new', is_own: true }]);
  assert.match(calls[0].text, /school_id = \?/);
  assert.match(calls[0].text, /ai_status = 'approved'/);
  assert.doesNotMatch(calls[0].text, /SELECT[^;]*user_id,/, 'the workflow exposes only an ownership boolean, not the author id');

  const txCalls = [];
  let currentStatus = 'new';
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); txCalls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'council_member', active: true }]];
    if (text.includes('FROM fam_ideas')) return [[{ admin_status: currentStatus }]];
    if (text.includes('UPDATE fam_ideas')) { currentStatus = values[0]; return [[]]; }
    return [[]];
  };
  const transactionalSql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(transactionalSql);
  const input = { ideaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schoolId: 'school-a', reviewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'in_progress' };
  assert.equal(await repo.updateSchoolIdeaWorkflow(input), true);
  assert.equal(currentStatus, 'in_progress');
  assert.ok(txCalls.some(call => call.values.includes('idea_workflow_in_progress')));
  assert.equal(await repo.updateSchoolIdeaWorkflow({ ...input, status: 'done' }), true);
  assert.equal(currentStatus, 'done');
  assert.equal(await repo.updateSchoolIdeaWorkflow({ ...input, status: 'rejected' }), false, 'terminal ideas cannot be re-opened');
});

test('school idea image lookup returns the AI review state for media authorization', async () => {
  const calls = [];
  const sql = async strings => {
    const text = strings.join('?'); calls.push(text);
    if (text.includes('FROM fam_ideas')) return [[{ user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', image_status: 'pending', ai_status: 'pending' }]];
    return [[{ object_key: 'pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp' }]];
  };
  const result = await createYdbListingsRepository(sql).getSchoolIdeaImage('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0);
  assert.equal(result.ai_status, 'pending');
  assert.match(calls[0], /ai_status/);
  assert.match(calls[1], /user_id = \?/);
  assert.match(calls[1], /school_id = \?/);
});

test('school idea image lookup rejects an image row linked to another owner or school', async () => {
  const ideaOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ideaSchool = 'school-a';
  const imageOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const imageSchool = 'school-b';
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_ideas')) {
      return [[{ user_id: ideaOwner, school_id: ideaSchool, image_status: 'pending', ai_status: 'pending' }]];
    }
    if (text.includes('FROM fam_idea_images')) {
      assert.deepEqual(values, [
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ideaOwner, ideaSchool, 0,
      ]);
      // A corrupted cross-school row cannot match the owner and school filters.
      return [[]];
    }
    return [[]];
  };
  const result = await createYdbListingsRepository(sql).getSchoolIdeaImage(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0);
  assert.equal(result, null);
  assert.notEqual(imageOwner, ideaOwner);
  assert.notEqual(imageSchool, ideaSchool);
  assert.match(calls[1].text, /user_id = \?/);
  assert.match(calls[1].text, /school_id = \?/);
});

test('idea deletion is owner-bound or same-school-admin-only and claims linked photos for cleanup', async () => {
  const ideaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const adminId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const imageKey = `pending/${ownerId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp`;
  const calls = [];
  let role = 'student'; let school = 'school-a'; let actorCalls = 0; let failAsCouncil = false;
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) {
      actorCalls += 1;
      return [[{ school_id: school, role: failAsCouncil ? 'council_member' : role, active: true }]];
    }
    if (text.includes('SELECT id, user_id, school_id FROM fam_ideas')) return school === 'school-a' ? [[{ id: ideaId, user_id: ownerId, school_id: 'school-a' }]] : [[]];
    if (text.includes('FROM fam_ideas')) return [[]];
    if (text.includes('FROM fam_idea_images')) return [[{ image_index: 0, object_key: imageKey }]];
    if (text.includes('FROM fam_pending_media')) return [[{ status: 'linked' }]];
    return [[]];
  };
  const sql = Object.assign((strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, school_id FROM fam_ideas')) return Promise.resolve([[{ id: ideaId, user_id: ownerId, school_id: 'school-a' }]]);
    if (text.includes('FROM fam_ideas')) return Promise.resolve([[]]);
    return Promise.resolve([[]]);
  }, { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.deepEqual(await repo.getSchoolIdeaDeletionContext({ ideaId, schoolId: 'school-a' }), { id: ideaId, user_id: ownerId, school_id: 'school-a' });
  assert.deepEqual(await repo.deleteSchoolIdea({ ideaId, actorId: ownerId, schoolId: 'school-a' }), {
    ok: true, own: true, media_cleanup: [{ object_key: imageKey, claim_token: calls.find(call => call.text.includes('UPDATE fam_pending_media')).values[0] }],
  });
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_idea_images')));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_ideas')));
  assert.equal(calls.some(call => call.text.includes('INSERT INTO fam_school_content_audit')), false, 'owner deletion does not create a staff audit row');

  calls.length = 0; role = 'school_admin';

  const adminDelete = await repo.deleteSchoolIdea({ ideaId, actorId: adminId, schoolId: 'school-a' });
  assert.equal(adminDelete.ok, true);
  assert.ok(calls.some(call => call.text.includes("'idea_deleted'")), 'staff deletion is recorded in the school content audit');
  calls.length = 0;
  role = 'council_member'; failAsCouncil = true;
  const councilDelete = await repo.deleteSchoolIdea({ ideaId, actorId: adminId, schoolId: 'school-a' });
  assert.ok(actorCalls >= 3);
  assert.deepEqual(councilDelete, { ok: false, code: 'forbidden' });
  school = 'school-b'; role = 'school_admin'; failAsCouncil = false;
  assert.deepEqual(await repo.deleteSchoolIdea({ ideaId, actorId: adminId, schoolId: 'school-b' }), { ok: false, code: 'idea_unavailable' });
});

test('account deletion request validates requester and target from same-school profiles before insert', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT school_id, role, active FROM fam_user_profiles')) {
      return [[{ school_id: 'school-a', role: calls.length === 1 ? 'council_member' : 'student', active: true }]];
    }
    if (text.includes('SELECT request_id, school_id FROM fam_account_deletion_open')) return [[]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.createAccountDeletionRequest({ schoolId: 'school-a', requesterId: 'council-id', targetId: 'student-id', reasonCode: 'spam', reason: 'Repeated unrelated messages in group.' });
  assert.equal(result.ok, true);
  const insert = calls.find(call => call.text.includes('INSERT INTO fam_account_deletion_requests'));
  assert.ok(insert);
  assert.ok(insert.values.includes('school-a'));
  assert.ok(insert.values.includes('council-id'));
  assert.ok(insert.values.includes('student-id'));
  assert.equal(insert.values.includes('https://issuer'), false);
  assert.match(insert.text, /'pending'/);
  const openKey = calls.find(call => call.text.includes('INSERT INTO fam_account_deletion_open'));
  assert.ok(openKey);
  assert.ok(openKey.values.includes('student-id'));
  assert.equal(await repo.createAccountDeletionRequest({ schoolId: '', requesterId: 'a', targetId: 'b', reasonCode: 'spam', reason: 'this is a sufficiently long reason' }).then(() => false, () => true), true);
});
test('account deletion history is private to its requester and rejection closes the request in one transaction', async () => {
  let listQuery; const calls = [];
  const sql = Object.assign((strings, ...values) => { listQuery = { text: strings.join('?'), values }; return Promise.resolve([[{ request_id: 'request-a', status: 'pending' }]]); }, {
    begin: callback => callback(async (strings, ...values) => {
      const text = strings.join('?'); calls.push({ text, values });
      if (text.includes('SELECT school_id, role, active FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
      if (text.includes('SELECT target_id, school_id, status FROM fam_account_deletion_requests')) return [[{ target_id: 'student-a', school_id: 'school-a', status: 'pending' }]];
      if (text.includes('SELECT request_id, school_id FROM fam_account_deletion_open')) return [[{ request_id: 'request-a', school_id: 'school-a' }]];
      if (text.includes('SELECT status FROM fam_account_deletion_requests')) return [[{ status: 'rejected' }]];
      return [[]];
    }),
  });
  const repo = createYdbListingsRepository(sql);
  const own = await repo.listOwnAccountDeletionRequests('school-a', 'council-a');
  assert.deepEqual(own, [{ request_id: 'request-a', status: 'pending' }]);
  assert.ok(listQuery.values.includes('school-a') && listQuery.values.includes('council-a'));
  assert.match(listQuery.text, /ORDER BY created_at DESC LIMIT 10/);
  assert.equal(await repo.rejectAccountDeletionRequest('request-a', 'school-a', 'admin-a', 'Проверено'), true);
  assert.ok(calls.some(call => call.text.includes("SET status = 'rejected'")));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_account_deletion_open')));
  assert.equal(await repo.rejectAccountDeletionRequest('request-a', 'other-school', 'admin-a'), false);
});
test('approved account deletion claims only an active same-school request and its eligible target in one transaction', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT school_id, role, active FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
    if (text.includes('SELECT target_id, school_id, status FROM fam_account_deletion_requests')) return [[{ target_id: 'target-a', school_id: 'school-a', status: 'pending' }]];
    if (text.includes('SELECT request_id, school_id FROM fam_account_deletion_open')) return [[{ request_id: 'request-a', school_id: 'school-a' }]];
    if (text.includes('SELECT user_id, issuer, subject, school_id, role, active FROM fam_user_profiles')) return [[{ user_id: 'target-a', issuer: 'https://issuer.test', subject: 'target-subject', school_id: 'school-a', role: 'student', active: true }]];
    if (text.includes('SELECT active FROM fam_user_profiles')) return [[{ active: false }]];
    if (text.includes('SELECT status FROM fam_account_deletion_requests')) return [[{ status: 'processing' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.beginRequestedAccountDeletion({ requestId: 'request-a', schoolId: 'school-a', reviewerId: 'admin-a' });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'target-a');
  assert.match(result.claim_token, /^[0-9a-f-]{36}$/i);
  assert.ok(calls.some(call => call.text.includes("SET status = 'processing'") && call.values.includes('request-a')));
  assert.ok(calls.some(call => call.text.includes('SET active = false') && call.values.includes('school-a')));
  const durableJob = calls.find(call => call.text.includes('INSERT INTO fam_account_deletion_jobs'));
  assert.ok(durableJob);
  assert.ok(durableJob.values.includes(result.claim_token));
});
test('account media inventory selects only linked idea and avatar keys for the requested user', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const key = `pending/${userId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
  const queries = [];
  const repo = createYdbListingsRepository(strings => {
    queries.push(strings.join('?'));
    return Promise.resolve([[{ object_key: key }]]);
  });
  assert.deepEqual(await repo.listAccountMediaKeys(userId), [key]);
  assert.match(queries[0], /fam_idea_images WHERE user_id = \\?/);
  assert.match(queries[1], /fam_avatar_reviews WHERE user_id = \\?/);
  const invalid = createYdbListingsRepository(() => Promise.resolve([[{ object_key: 'pending/11111111-1111-4111-8111-111111111111/not-a-uuid.webp' }]]));
  await assert.rejects(invalid.listAccountMediaKeys(userId), /invalid account media key/);
});

test('direct account deletion requires an active same-school administrator and student or council target', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT school_id, role, active FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
    if (text.includes('SELECT user_id, issuer, subject, school_id, role, active FROM fam_user_profiles')) return [[{ user_id: 'target-a', issuer: 'https://issuer.test', subject: 'target-subject', school_id: 'school-a', role: 'council_member', active: true }]];
    if (text.includes('SELECT active FROM fam_user_profiles')) return [[{ active: false }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.beginAdminAccountDeletion({ schoolId: 'school-a', reviewerId: 'admin-a', targetId: 'target-a' });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'target-a');
  assert.equal(result.role, 'council_member');
  assert.match(result.claim_token, /^[0-9a-f-]{36}$/i);
  const scopedDeactivate = calls.find(call => call.text.includes('UPDATE fam_user_profiles SET active = false'));
  assert.ok(scopedDeactivate);
  assert.ok(scopedDeactivate.values.includes('school-a'));
  assert.match(scopedDeactivate.text, /role IN \('student', 'council_member'\)/);
  assert.equal(await repo.beginAdminAccountDeletion({ schoolId: 'school-a', reviewerId: 'same-id', targetId: 'same-id' }).then(() => false, () => true), true);
});
test('account deletion clears private per-user state and redacts safety attribution atomically', async () => {
  const calls = [];
  const userId = '11111111-1111-4111-8111-111111111111';
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT issuer, subject, school_id, source, actor_id, request_id')) {
      return [[{ issuer: 'https://issuer.test', subject: 'synthetic', school_id: 'school-a', source: 'self', actor_id: userId,
        request_id: '', target_role: 'student', review_note: '', lease_valid: true }]];
    }
    if (text.includes('SELECT active, school_id FROM fam_user_profiles')) return [[{ active: false, school_id: 'school-a' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const result = await createYdbListingsRepository(sql).finishAccountDeletion({ issuer: 'https://issuer.test', subject: 'synthetic',
    userId, schoolId: 'school-a', claimToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.deepEqual(result, { ok: true, deleted: true });
  for (const table of ['fam_avatar_reviews', 'fam_notification_reads', 'fam_submission_quotas']) {
    const cleanup = calls.find(call => call.text.includes('DELETE FROM ' + table));
    assert.ok(cleanup, table + ' is cleared');
    assert.ok(cleanup.values.includes(userId));
  }
  const audit = calls.find(call => call.text.includes('UPDATE fam_school_content_audit'));
  assert.ok(audit); assert.ok(audit.values.includes(userId)); assert.ok(audit.text.includes('deleted-account'));
  const safety = calls.find(call => call.text.includes('UPDATE fam_safety_incidents'));
  assert.ok(safety); assert.ok(safety.values.includes(userId));
  assert.ok(safety.text.includes('evidence_excerpt = CAST(NULL AS Utf8?)'));
});
test('profile identity update changes only first name, last name, and class for its issuer/subject key', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, active, person_type, staff_position')) return [[{ user_id: 'synthetic-user', active: true, person_type: 'student', staff_position: '', staff_verification_status: 'not_required' }]];
    if (text.includes('SELECT user_id AS id, school_id')) return [[{ id: 'synthetic-user', school_id: 'school-a', role: 'student', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.updateOwnProfileIdentity('https://issuer.test', 'student-sub', {
    first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'student', staff_position: '',
    role: 'school_admin', school_id: 'foreign-school',
  });
  assert.equal(result.first_name, 'Аня');
  const update = calls.find(call => call.text.includes('UPDATE fam_user_profiles'));
  assert.ok(update.values.includes('Аня')); assert.ok(update.values.includes('Иванова')); assert.ok(update.values.includes('8А'));
  assert.ok(update.values.includes('https://issuer.test')); assert.ok(update.values.includes('student-sub'));
  assert.ok(update.values.includes('student'));
  assert.match(update.text, /user_id = \? AND active = true/);
  assert.doesNotMatch(update.text, /school_id\s*=|role\s*=/i,
    'self-service profile updates never write school or application role');
  assert.ok(!update.values.includes('foreign-school'));
  await assert.rejects(repo.updateOwnProfileIdentity('issuer', 'subject', { first_name: 'x', last_name: 'y' }), TypeError);
});
test('school role request submission is bound to the database student profile and prevents duplicates', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, school_id, role, active FROM fam_user_profiles')) return [[{ user_id: 'student-id', school_id: 'school-a', role: 'student', active: true }]];
    if (text.includes('SELECT request_id, status FROM fam_school_role_requests')) return [[]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.createSchoolRoleRequest({ issuer: 'https://issuer.test', subject: 'student-sub', requested_role: 'school_admin' });
  assert.equal(result.ok, true); assert.equal(result.status, 'pending');
  const upsert = calls.find(call => call.text.includes('UPSERT INTO fam_school_role_requests'));
  assert.ok(upsert.values.includes('student-id'));
  assert.ok(upsert.values.includes('school-a'));
  assert.ok(upsert.values.includes('school_admin'));
  assert.equal(upsert.text.includes('https://issuer.test'), false);
  assert.ok(calls.some(call => call.text.includes('INSERT INTO fam_school_role_request_audit')));
  await assert.rejects(repo.createSchoolRoleRequest({ issuer: 'x', subject: 'y', requested_role: 'owner' }), TypeError);
});

test('school role approval requires same-school review ownership and promotes only the applicant profile', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT school_id, role, active FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
    if (text.includes('SELECT issuer, subject, user_id, school_id, requested_role, status, review_started_by')) return [[{ issuer: 'https://issuer.test', subject: 'student-sub', user_id: 'student-id', school_id: 'school-a', requested_role: 'council_member', status: 'reviewing', review_started_by: 'admin-id' }]];
    if (text.includes('SELECT user_id, school_id, role, active FROM fam_user_profiles')) return [[{ user_id: 'student-id', school_id: 'school-a', role: 'student', active: true }]];
    if (text.includes('SELECT status FROM fam_school_role_requests')) return [[{ status: 'approved' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.reviewSchoolRoleRequest('request-id', 'school-a', 'admin-id', 'approve', 'Проверено'), true);
  const promote = calls.find(call => call.text.includes('UPDATE fam_user_profiles SET role'));
  assert.ok(promote.values.includes('council_member'));
  assert.ok(promote.values.includes('student-id'));
  assert.ok(promote.values.includes('school-a'));
  assert.match(promote.text, /role = 'student' AND active = true/);
  assert.ok(calls.some(call => call.text.includes('INSERT INTO fam_school_role_request_audit')));
  assert.equal(await repo.reviewSchoolRoleRequest('request-id', 'school-b', 'admin-id', 'approve'), false);
  await assert.rejects(repo.reviewSchoolRoleRequest('id', 'school-a', 'admin-id', 'school_admin'), TypeError);
});
test('listing insert binds user content as data and writes only pending status', async () => {
  const calls = [];
  const tx = async (strings, ...values) => { calls.push({ text: strings.join('?'), values }); return [[]]; };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const payload = "Книга'); DELETE FROM fam_listings; --";
  const row = { user_id: 'u1', school_id: 's1', title: payload, description: 'text', category: 'Учёба', price_text: '100 ₽', is_event: false, event_date: null, event_time: null, event_type: null, max_seats: 0, image_key: null, photo_status: 'none', status: 'pending' };
  const result = await repo.createListing(row);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  const query = calls.find(call => call.text.includes('INSERT INTO fam_listings'));
  assert.equal(query.text.includes(payload), false);
  assert.ok(query.values.includes(payload));
  assert.ok(query.values.includes(''));
  assert.ok(query.values.includes('none'));
  await assert.rejects(repo.createListing({ ...row, status: 'active' }));
});

test('listing submissions enforce a durable per-user hourly quota before insertion', async () => {
  let count = 0;
  const tx = async (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('SELECT submission_count FROM fam_submission_quotas')) return count ? [[{ submission_count: count }]] : [[]];
    if (text.includes('UPSERT INTO fam_submission_quotas')) { count = values.find(Number.isInteger); return [[]]; }
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const row = { user_id: 'synthetic-user', school_id: 'synthetic-school', title: 'Книга', description: 'Учебник',
    category: 'Учёба', price_text: 'Бесплатно', is_event: false, max_seats: 0, status: 'pending' };
  for (let i = 0; i < 5; i++) await repo.createListing(row);
  assert.deepEqual(await repo.createListing(row), { ok: false, code: 'rate_limited' });
  assert.equal(count, 5);
});

test('idea submissions enforce the upstream five-per-hour durable quota', async () => {
  let count = 0;
  const tx = async (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('SELECT submission_count FROM fam_submission_quotas')) return count ? [[{ submission_count: count }]] : [[]];
    if (text.includes('UPSERT INTO fam_submission_quotas')) { count = values.find(Number.isInteger); return [[]]; }
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const idea = { user_id: 'synthetic-user', school_id: 'synthetic-school', text: 'Идея',
    ai_status: 'pending', ai_summary: '', ai_reason: '', admin_status: 'new' };
  for (let index = 0; index < 5; index++) assert.ok((await repo.createIdea(idea)).id);
  assert.deepEqual(await repo.createIdea(idea), { ok: false, code: 'rate_limited' });
  assert.equal(count, 5);
});

test('photo listing creation atomically links only a fresh pending upload owned by the listing author', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, status FROM fam_pending_media')) return [[{ user_id: '11111111-1111-4111-8111-111111111111', status: 'pending' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const imageKey = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  const result = await repo.createListing({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a',
    title: 'Фото', description: 'Описание', category: 'Творчество', price_text: 'Бесплатно', is_event: false,
    max_seats: 0, image_key: imageKey, photo_status: 'pending', status: 'pending' });
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.ok(calls.findIndex(call => call.text.includes('SELECT user_id, status FROM fam_pending_media'))
    < calls.findIndex(call => call.text.includes('INSERT INTO fam_listings')));
  assert.ok(calls.find(call => call.text.includes("SET status = 'linked'")));

  const rejected = createYdbListingsRepository(Object.assign(() => Promise.resolve([[]]), {
    begin: callback => callback(async strings => strings.join('').includes('SELECT user_id, status FROM fam_pending_media')
      ? [[{ user_id: 'someone-else', status: 'pending' }]] : [[]]),
  }));
  await assert.rejects(rejected.createListing({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'school-a',
    title: 'Фото', description: 'Описание', category: 'Творчество', price_text: 'Бесплатно', is_event: false,
    max_seats: 0, image_key: imageKey, status: 'pending' }), error => error.code === 'pending_image_unavailable');
});

test('pending-media repository validates ownership keys and claims only expired unlinked uploads', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT object_key FROM fam_pending_media')) return [[{ object_key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp' }]];
    if (text.includes('SELECT id FROM fam_listings WHERE image_key')) return [[]];
    if (text.includes('SELECT idea_id FROM fam_idea_images')) return [[]];
    if (text.includes('SELECT id FROM fam_avatar_reviews WHERE image_key')) return [[]];
    if (text.includes('SELECT object_key, claim_token FROM fam_pending_media')) return [[{ object_key: values[0], claim_token: values[1] }]];
    if (text.includes('SELECT status FROM fam_pending_media')) return [[{ status: 'deleting' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  assert.equal(await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', key), true);
  await assert.rejects(repo.registerPendingImage('invalid', key), TypeError);
  const claims = await repo.claimExpiredPendingImages(5);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].object_key, key);
  assert.match(calls.find(call => call.text.includes("status = 'pending' AND created_at" )).text, /Interval\('P7D'\)/);
  assert.ok(calls.some(call => call.text.includes('FROM fam_idea_images WHERE object_key')));
  assert.ok(calls.some(call => call.text.includes('FROM fam_avatar_reviews WHERE image_key')));
  assert.equal(await repo.finishPendingImageCleanup(key, claims[0].claim_token, false), true);
  assert.ok(calls.some(call => call.text.includes("SET status = 'pending', claim_token = ''")));
  assert.equal(await repo.finishPendingImageCleanup(key, claims[0].claim_token, true), true);
  await assert.rejects(repo.claimExpiredPendingImages(101), TypeError);
});

test('pending-media cleanup protects expired uploads still referenced by an idea or avatar review', async () => {
  for (const linkedTable of ['fam_idea_images', 'fam_avatar_reviews']) {
    const calls = [];
    const tx = async (strings) => {
      const text = strings.join('?'); calls.push(text);
      if (text.includes('SELECT object_key FROM fam_pending_media')) return [[{ object_key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp' }]];
      if (text.includes('SELECT id FROM fam_listings WHERE image_key')) return [[]];
      if (text.includes('SELECT idea_id FROM fam_idea_images')) return linkedTable === 'fam_idea_images' ? [[{ idea_id: 'idea-1' }]] : [[]];
      if (text.includes('SELECT id FROM fam_avatar_reviews WHERE image_key')) return linkedTable === 'fam_avatar_reviews' ? [[{ id: 'avatar-1' }]] : [[]];
      return [[]];
    };
    const repo = createYdbListingsRepository(Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) }));
    assert.deepEqual(await repo.claimExpiredPendingImages(5), []);
    assert.ok(calls.some(text => text.includes("SET status = 'linked', claim_token = ''")));
    assert.equal(calls.some(text => text.includes("SET status = 'deleting'")), false);
  }
});

test('avatar upload is atomically queued as linked private media and only same-school decisions publish it', async () => {
  const calls = [];
  let decision = 'approved';
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, status FROM fam_pending_media')) return [[{ user_id: '11111111-1111-4111-8111-111111111111', status: 'pending' }]];
    if (text.includes('SELECT id FROM fam_avatar_reviews WHERE user_id')) return [[]];
    if (text.includes('SELECT role, school_id, active FROM fam_user_profiles')) return [[{ role: 'school_admin', school_id: 'school-a', active: true }]];
    if (text.includes('SELECT user_id, image_key, status FROM fam_avatar_reviews')) return [[{ user_id: '11111111-1111-4111-8111-111111111111', image_key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', status: 'pending' }]];
    if (text.includes('SELECT issuer, subject FROM fam_user_profiles')) return [[{ issuer: 'https://issuer.example', subject: 'synthetic' }]];
    if (text.includes('SELECT status FROM fam_avatar_reviews WHERE id =')) return [[{ status: decision }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const imageKey = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  const request = await repo.createAvatarReview({ userId: '11111111-1111-4111-8111-111111111111', schoolId: 'school-a', imageKey });
  assert.equal(request.status, 'pending');
  assert.ok(calls.some(call => call.text.includes('SELECT submission_count FROM fam_submission_quotas')
    && call.values.includes('listing')), 'avatar review consumes the shared listing quota');
  assert.ok(calls.some(call => call.text.includes('INSERT INTO fam_avatar_reviews')));
  assert.ok(calls.some(call => call.text.includes("UPDATE fam_pending_media SET status = 'linked'")));
  assert.equal(await repo.moderateAvatarReview(request.id, 'school-a', 'moderator-id', 'approved'), true);
  const profileUpdate = calls.find(call => call.text.includes('UPDATE fam_user_profiles SET avatar_url'));
  assert.ok(profileUpdate);
  assert.ok(profileUpdate.values.includes(`/api/v1/avatars/${request.id}/photo`));
  assert.ok(calls.some(call => call.text.includes('SET status = ?') && call.text.includes('WHERE id = ? AND school_id = ? AND status =')));
  decision = 'rejected';
  assert.equal(await repo.moderateAvatarReview(request.id, 'school-a', 'moderator-id', 'rejected'), true);
  assert.ok(calls.some(call => call.text.includes("UPDATE fam_pending_media SET status = 'pending'")));
});

test('avatar review rejects an exhausted shared listing quota before linking the pending image', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, status FROM fam_pending_media')) return [[{ user_id: '11111111-1111-4111-8111-111111111111', status: 'pending' }]];
    if (text.includes('SELECT id FROM fam_avatar_reviews WHERE user_id')) return [[]];
    if (text.includes('SELECT submission_count FROM fam_submission_quotas')) return [[{ submission_count: 5 }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const imageKey = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  assert.deepEqual(await repo.createAvatarReview({ userId: '11111111-1111-4111-8111-111111111111', schoolId: 'school-a', imageKey }),
    { ok: false, code: 'rate_limited' });
  assert.equal(calls.some(call => call.text.includes('INSERT INTO fam_avatar_reviews')), false);
  assert.equal(calls.some(call => call.text.includes("UPDATE fam_pending_media SET status = 'linked'")), false);
});

test('own listing deletion is owner-bound and removes dependents in one transaction', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, is_event, image_key FROM fam_listings')) {
      return [[{ user_id: '11111111-1111-4111-8111-111111111111', is_event: true,
        image_key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp' }]];
    }
    if (text.includes('SELECT status FROM fam_pending_media')) return [[{ status: 'linked' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const result = await repo.deleteOwnListing('11111111-1111-4111-8111-111111111111', id);
  assert.equal(result.id, id);
  assert.equal(result.media_cleanup.object_key, 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp');
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_event_registrations')));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_event_occupancy')));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_favorites')));
  assert.ok(calls.some(call => call.text.includes("SET status = 'deleting'")));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_listings')));
  assert.ok(calls.find(call => call.text.includes('DELETE FROM fam_listings')).values.includes('11111111-1111-4111-8111-111111111111'));
  assert.equal(await repo.deleteOwnListing('22222222-2222-4222-8222-222222222222', id), null);
  await assert.rejects(repo.deleteOwnListing('student-id', 'not-a-uuid'), TypeError);
});

test('favorite repository binds user and listing ids and refuses to favorite a missing listing', async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    const query = { text: strings.join('?'), values };
    calls.push(query);
    if (query.text.includes('SELECT id FROM fam_listings')) return Promise.resolve([[]]);
    return Promise.resolve([[]]);
  };
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.setFavorite('synthetic-user', 'inactive-listing', true), false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].values.includes('inactive-listing'));
  assert.ok(calls[0].text.includes("status = 'active'"));
  await repo.setFavorite('synthetic-user', 'listing-1', false);
  assert.equal(calls[1].text.includes('synthetic-user'), false);
  assert.ok(calls[1].values.includes('synthetic-user'));
  assert.ok(calls[1].values.includes('listing-1'));
});

test('pending photo cleanup query binds the object key before deletion eligibility is decided', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ id: 'linked-listing' }]]);
  });
  const imageKey = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  assert.equal(await repo.listingUsesPhoto(imageKey), true);
  assert.equal(query.text.includes(imageKey), false);
  assert.ok(query.values.includes(imageKey));
  assert.match(query.text, /FROM fam_listings WHERE image_key = \?/);
});

test('moderation queue is school-scoped and returns no storage key', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ id: 'listing-id', title: 'Синтетика', description: 'Описание', category: 'Учёба', school_id: 'school-a', image_key: 'private/key', photo_status: 'pending', status: 'pending' }]]);
  });
  const rows = await repo.listPendingListings('school-a');
  assert.ok(query.values.includes('school-a'));
  assert.match(query.text, /school_id = \?/);
  assert.match(query.text, /status = 'pending'/);
  assert.equal(rows[0].photo_url, '/api/v1/listings/listing-id/photo');
  assert.equal(Object.hasOwn(rows[0], 'image_key'), false);
});

test('message repository verifies same-school active recipient before inserting bound content', async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    const query = { text: strings.join('?'), values };
    calls.push(query);
    if (query.text.includes('FROM fam_user_profiles')) return Promise.resolve([[
      { user_id: 'sender-id', school_id: 'school-id', active: true },
      { user_id: 'recipient-id', school_id: 'school-id', active: true },
    ]]);
    if (query.text.includes('FROM fam_listings')) return Promise.resolve([[{ user_id: 'recipient-id', school_id: 'school-id' }]]);
    return Promise.resolve([[]]);
  };
  sql.begin = callback => callback(sql);
  const repo = createYdbListingsRepository(sql);
  const result = await repo.createMessage({ sender_id: 'sender-id', receiver_id: 'recipient-id', school_id: 'school-id', listing_id: 'listing-id', body: 'Привет' });
  assert.ok(calls.some(call => call.text.includes('listing_id') && call.values.includes('listing-id')));
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.ok(calls.some(call => call.values.includes('school-id')));
  assert.ok(calls.some(call => call.values.includes('recipient-id')));
  assert.ok(calls.some(call => call.values.includes('Привет')));
  const quotaRead = calls.find(call => call.text.includes('SELECT submission_count FROM fam_submission_quotas'));
  assert.ok(quotaRead.values.includes('message'));
  assert.match(quotaRead.text, /window_start > CurrentUtcTimestamp\(\) - Interval\('PT1M'\)/, 'message quota rolls from the last message');

  let inserts = 0;
  const absentSql = strings => {
    if (strings.join('').includes('FROM fam_user_profiles')) return Promise.resolve([[]]);
    inserts++;
    return Promise.resolve([[]]);
  };
  absentSql.begin = callback => callback(absentSql);
  const absent = createYdbListingsRepository(absentSql);
  assert.deepEqual(await absent.createMessage({ sender_id: 'sender-id', receiver_id: 'outside-school', school_id: 'school-id', body: 'Привет' }),
    { ok: false, code: 'recipient_unavailable' });
  assert.equal(inserts, 0);
});

test('message repository blocks cross-school participants and listings unrelated to the chat', async () => {
  const inserts = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('SELECT user_id, school_id, active FROM fam_user_profiles')) return Promise.resolve([[
      { user_id: 'sender-id', school_id: 'school-a', active: true },
      { user_id: 'recipient-id', school_id: 'school-b', active: true },
    ]]);
    if (text.includes('SELECT user_id, school_id FROM fam_listings')) return Promise.resolve([[{ user_id: 'other-id', school_id: 'school-a' }]]);
    if (text.includes('INSERT INTO fam_messages') || text.includes('INSERT INTO fam_pending_messages')) inserts.push({ text, values });
    return Promise.resolve([[]]);
  };
  sql.begin = callback => callback(sql);
  const repository = createYdbListingsRepository(sql);
  const mismatchedSchool = { sender_id: 'sender-id', receiver_id: 'recipient-id', school_id: 'school-a', body: 'synthetic' };
  assert.deepEqual(await repository.createMessage(mismatchedSchool), { ok: false, code: 'recipient_unavailable' });
  await assert.rejects(repository.createPendingMessage(mismatchedSchool), error => error.code === 'recipient_unavailable');
  assert.equal(inserts.length, 0, 'a cross-school recipient is rejected before either message table is written');

  const participants = [
    { user_id: 'sender-id', school_id: 'school-a', active: true },
    { user_id: 'recipient-id', school_id: 'school-a', active: true },
  ];
  const unrelatedListingSql = (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('SELECT user_id, school_id, active FROM fam_user_profiles')) return Promise.resolve([participants]);
    if (text.includes('SELECT user_id, school_id FROM fam_listings')) return Promise.resolve([[{ user_id: 'other-id', school_id: 'school-a' }]]);
    if (text.includes('INSERT INTO fam_messages')) inserts.push({ text, values });
    return Promise.resolve([[]]);
  };
  unrelatedListingSql.begin = callback => callback(unrelatedListingSql);
  const unrelatedListingRepository = createYdbListingsRepository(unrelatedListingSql);
  assert.deepEqual(await unrelatedListingRepository.createMessage({ ...mismatchedSchool,
    receiver_id: 'recipient-id', listing_id: 'unrelated-listing' }), { ok: false, code: 'recipient_unavailable' });
  assert.equal(inserts.length, 0, 'a listing outside the sender/recipient pair is rejected before insert');
});

test('directly delivered messages enforce a rolling eight-per-minute durable account quota', async () => {
  const statements = [];
  let count = 0;
  let now = Date.now();
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return Promise.resolve([[
      { user_id: 'sender-id', school_id: 'school-id', active: true },
      { user_id: 'recipient-id', school_id: 'school-id', active: true },
    ]]);
    if (text.includes('FROM fam_listings')) return Promise.resolve([[{ user_id: 'recipient-id', school_id: 'school-id' }]]);
    if (text.includes('SELECT submission_count FROM fam_submission_quotas')) {
      return Promise.resolve(now - lastSentAt < 60_000 && count ? [[{ submission_count: count }]] : [[]]);
    }
    if (text.includes('DELETE FROM fam_submission_quotas')) { count = 0; return Promise.resolve([[]]); }
    if (text.includes('UPSERT INTO fam_submission_quotas')) {
      count = values.find(Number.isInteger);
      lastSentAt = now;
      return Promise.resolve([[]]);
    }
    return Promise.resolve([[]]);
  };
  let lastSentAt = 0;
  sql.begin = callback => callback(sql);
  const repo = createYdbListingsRepository(sql);
  for (let index = 0; index < 8; index++) {
    assert.match((await repo.createMessage({ sender_id: 'sender-id', receiver_id: 'recipient-id',
      school_id: 'school-id', body: `Message ${index}` })).id, /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(await repo.createMessage({ sender_id: 'sender-id', receiver_id: 'recipient-id',
    school_id: 'school-id', body: 'Message 9' }), { ok: false, code: 'rate_limited' });
  assert.equal(statements.filter(statement => statement.text.includes('INSERT INTO fam_messages')).length, 8);
  now += 60_001;
  assert.match((await repo.createMessage({ sender_id: 'sender-id', receiver_id: 'recipient-id',
    school_id: 'school-id', body: 'Message after quiet period' })).id, /^[0-9a-f-]{36}$/);
  assert.equal(count, 1, 'the counter resets after one minute without sending');
});

test('pending messages share the upstream eight-per-minute quota with delivered messages', async () => {
  const statements = [];
  let count = 0;
  const tx = async (strings, ...values) => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('SELECT user_id, school_id, active FROM fam_user_profiles')) return [[
      { user_id: 'sender-id', school_id: 'school-id', active: true },
      { user_id: 'recipient-id', school_id: 'school-id', active: true },
    ]];
    if (text.includes('FROM fam_listings')) return [[{ user_id: 'recipient-id', school_id: 'school-id' }]];
    if (text.includes('SELECT submission_count FROM fam_submission_quotas')) return count ? [[{ submission_count: count }]] : [[]];
    if (text.includes('DELETE FROM fam_submission_quotas')) { count = 0; return [[]]; }
    if (text.includes('UPSERT INTO fam_submission_quotas')) { count = values.find(Number.isInteger); return [[]]; }
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const pending = { sender_id: 'sender-id', receiver_id: 'recipient-id', school_id: 'school-id', body: 'Нужно проверить' };
  for (let index = 0; index < 8; index++) assert.ok((await repo.createPendingMessage(pending)).id);
  await assert.rejects(repo.createPendingMessage(pending), error => error.code === 'rate_limited');
  assert.equal(statements.filter(statement => statement.text.includes('INSERT INTO fam_pending_messages')).length, 8);
  assert.equal(statements.filter(statement => statement.text.includes('SELECT submission_count FROM fam_submission_quotas')
    && statement.values.includes('message')).length, 9);
  assert.deepEqual(await repo.createMessage({ ...pending }), { ok: false, code: 'rate_limited' },
    'pending submissions consume the same message quota as messages sent directly to the inbox');
});

test('message reads bind user and school and return only the bounded projection', async () => {
  let query;
  const sql = (strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ id: 'message-id', sender_id: 'user-id', receiver_id: 'other-id', body: 'private', school_id: 'school-id' }]]);
  };
  const repo = createYdbListingsRepository(sql);
  const rows = await repo.listMessages('user-id', 'school-id');
  assert.equal(query.values.includes('user-id'), true);
  assert.equal(query.values.includes('school-id'), true);
  assert.match(query.text, /sender_id = \?/);
  assert.match(query.text, /receiver_id = \?/);
  assert.equal(rows[0].body, 'private');
});

test('mark-read scopes both the update and confirmation to recipient and school', async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    const query = { text: strings.join('?'), values }; calls.push(query);
    return Promise.resolve(calls.length === 2 ? [[{ id: 'message-id' }]] : [[]]);
  };
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.markMessageRead('recipient-id', 'school-id', 'message-id'), true);
  assert.match(calls[0].text, /SET is_read = true/);
  assert.match(calls[0].text, /receiver_id = \?/);
  assert.match(calls[0].text, /school_id = \?/);
  assert.ok(calls[0].values.includes('recipient-id'));
  assert.ok(calls[0].values.includes('school-id'));
  assert.match(calls[1].text, /receiver_id = \?/);
  assert.match(calls[1].text, /school_id = \?/);

  let writes = 0;
  const absent = createYdbListingsRepository(() => { writes++; return Promise.resolve([[]]); });
  assert.equal(await absent.markMessageRead('other-user', 'school-id', 'message-id'), false);
  assert.equal(writes, 2);
});

test('listing moderation revalidates reviewer role, school and suspension in its transaction', async () => {
  const operations = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); operations.push({ text, values });
    if (text.includes('SELECT role')) return [[{ role: 'school_admin', school_id: 'school-a', active: true }]];
    if (text.includes('SELECT suspension_id')) return [[]];
    return text.includes('SELECT school_id') ? [[{ school_id: 'school-a', status: 'pending', image_key: '', photo_status: 'none' }]] : [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.moderateListing('listing-id', 'school-a', 'reviewer-id', 'active'), true);
  assert.match(operations[0].text, /SELECT role, school_id, active/);
  assert.match(operations[1].text, /fam_account_suspensions/);
  assert.match(operations[2].text, /SELECT school_id, status, image_key, photo_status/);
  assert.match(operations[3].text, /SET status = \?/);
  assert.deepEqual(operations[3].values, ['active', 'listing-id']);
  const transaction = responder => async (strings) => {
    const text = strings.join('');
    if (text.includes('SELECT role')) return [[{ role: 'school_admin', school_id: 'school-a', active: true }]];
    if (text.includes('SELECT suspension_id')) return [[]];
    return responder(text);
  };
  const photoOperations = [];
  const photoRepo = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(async (strings, ...values) => {
    const text = strings.join('?'); photoOperations.push({ text, values });
    if (text.includes('SELECT role')) return [[{ role: 'council_member', school_id: 'school-a', active: true }]];
    if (text.includes('SELECT suspension_id')) return [[]];
    if (text.includes('SELECT school_id')) return [[{ school_id: 'school-a', status: 'pending', image_key: 'pending/image.webp', photo_status: 'pending' }]];
    return [[]];
  }) }));
  assert.equal(await photoRepo.moderateListingPhoto('listing-id', 'school-a', 'reviewer-id', 'approved'), true);
  assert.match(photoOperations[0].text, /SELECT role, school_id, active/);
  assert.match(photoOperations[1].text, /fam_account_suspensions/);
  assert.match(photoOperations[2].text, /SELECT school_id, status, image_key, photo_status/);
  assert.match(photoOperations[3].text, /SET photo_status = \?/);
  const suspendedPhoto = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(async strings => {
    const text = strings.join('');
    if (text.includes('SELECT role')) return [[{ role: 'school_admin', school_id: 'school-a', active: true }]];
    if (text.includes('SELECT suspension_id')) return [[{ suspension_id: 'active' }]];
    return [[]];
  }) }));
  assert.equal(await suspendedPhoto.moderateListingPhoto('listing-id', 'school-a', 'reviewer-id', 'rejected'), false);
  const photoPending = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(transaction(text => text.includes('SELECT school_id') ? [[{ school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' }]] : [[]])) }));
  assert.equal(await photoPending.moderateListing('photo-listing', 'school-a', 'reviewer-id', 'active'), false, 'photo listings stay pending before photo approval');
  for (const row of [{ school_id: 'school-b', status: 'pending', image_key: '', photo_status: 'none' }, { school_id: 'school-a', status: 'active', image_key: '', photo_status: 'none' }, null]) {
    const blockedTx = transaction(text => text.includes('SELECT school_id') ? [[row].filter(Boolean)] : [[]]);
    const blocked = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(blockedTx) }));
    assert.equal(await blocked.moderateListing('listing-id', 'school-a', 'reviewer-id', 'rejected'), false);
  }
  for (const reviewer of [null, { role: 'student', school_id: 'school-a', active: true }, { role: 'school_admin', school_id: 'school-b', active: true }, { role: 'school_admin', school_id: 'school-a', active: false }]) {
    const guarded = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(async strings => strings.join('').includes('SELECT role') ? [[reviewer].filter(Boolean)] : [[]]) }));
    assert.equal(await guarded.moderateListing('listing-id', 'school-a', 'reviewer-id', 'active'), false);
  }
  const suspended = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(async strings => {
    const text = strings.join('');
    if (text.includes('SELECT role')) return [[{ role: 'council_member', school_id: 'school-a', active: true }]];
    if (text.includes('SELECT suspension_id')) return [[{ suspension_id: 'suspension-id' }]];
    return [[]];
  }) }));
  assert.equal(await suspended.moderateListing('listing-id', 'school-a', 'reviewer-id', 'rejected'), false);
  await assert.rejects(repo.moderateListing('listing-id', 'school-a', 'reviewer-id', 'pending'), TypeError);
  await assert.rejects(repo.moderateListingPhoto('listing-id', 'school-a', 'reviewer-id', 'pending'), TypeError);
});

test('event applicant query binds event and school and exposes only profile display fields', async () => {
  let query;
  const sql = async (strings, ...values) => { query = { text: strings.join('?'), values }; return [[{ user_id: 'u1', first_name: 'Аня', class_name: '8А', status: 'pending' }]]; };
  const repo = createYdbListingsRepository(sql);
  const rows = await repo.listEventApplicants('event-1', 'school-a', 'owner-id');
  assert.equal(rows[0].user_id, 'u1');
  assert.deepEqual(query.values, ['event-1', 'school-a', 'owner-id', 'owner-id', 'school-a']);
  assert.match(query.text, /r\.school_id = \?/);
  assert.match(query.text, /l\.user_id = \? OR EXISTS/);
  assert.match(query.text, /viewer\.active = true AND viewer\.role IN/);
  assert.match(query.text, /l\.status = 'active'/);
  assert.doesNotMatch(query.text, /email|phone|address/i);
  await assert.rejects(repo.listEventApplicants('event-1', '', 'owner-id'), TypeError);
});

test('pending event review queue binds the school and exposes only minimal applicant fields', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ event_id: 'event-a', event_title: 'Встреча', user_id: 'student-a', status: 'pending', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' }]]);
  });
  const rows = await repo.listPendingEventReviews('school-a');
  assert.ok(query.values.includes('school-a'));
  assert.match(query.text, /r\.school_id = \?/);
  assert.match(query.text, /l\.is_event = true/);
  assert.match(query.text, /l\.status = 'active'/);
  assert.match(query.text, /r\.status = 'pending'/);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['class_name', 'event_id', 'event_title', 'first_name', 'last_name', 'status', 'user_id']);
  assert.doesNotMatch(query.text, /email|phone|address/i);
  await assert.rejects(repo.listPendingEventReviews(''), TypeError);
});

test('event registration reserves a seat and stores only the database actor identity in one transaction', async () => {
  const operations = [];
  const beginOptions = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); operations.push({ text, values });
    if (text.includes('FROM fam_listings')) return [[{ user_id: 'organizer', school_id: 'school-a', is_event: true, status: 'active', event_type: 'limited', max_seats: 1 }]];
    if (text.includes('FROM fam_event_registrations')) return [[]];
    if (text.includes('FROM fam_event_occupancy')) return [[{ taken: 0 }]];
    return [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async (options, work) => {
    if (typeof options === 'function') return options(tx);
    beginOptions.push(options);
    return work(tx);
  } });
  const repo = createYdbListingsRepository(sql);
  assert.deepEqual(await repo.registerForEvent('event-id', 'verified-user', 'school-a'), { event_id: 'event-id', user_id: 'verified-user', status: 'confirmed' });
  assert.deepEqual(beginOptions, [], 'capacity transactions must surface serialization conflicts instead of retrying');
  assert.ok(operations.some(operation => operation.text.includes('UPSERT INTO fam_event_occupancy')));
  const registration = operations.find(operation => operation.text.includes('UPSERT INTO fam_event_registrations'));
  assert.ok(registration.values.includes('verified-user'));
  assert.equal(registration.text.includes('forged-user'), false);
});

test('event capacity and organizer rejection are returned after the YDB transaction instead of aborting it', async () => {
  const options = [];
  const makeRepo = ({ owner = 'organizer', taken = 1, existing = [] } = {}) => {
    const tx = async strings => {
      const text = strings.join('');
      if (text.includes('FROM fam_listings')) return [[{ user_id: owner, school_id: 'school-a', is_event: true, status: 'active', event_type: 'limited', max_seats: 1 }]];
      if (text.includes('FROM fam_event_registrations')) return [existing];
      if (text.includes('FROM fam_event_occupancy')) return [[{ taken }]];
      return [[]];
    };
    return createYdbListingsRepository(Object.assign(async () => [[]], { begin: async (settings, work) => {
      if (typeof settings === 'function') return settings(tx);
      options.push(settings);
      return work(tx);
    } }));
  };
  await assert.rejects(makeRepo().registerForEvent('event-id', 'student', 'school-a'), error => error.code === 'no_seats_available');
  await assert.rejects(makeRepo({ owner: 'student', taken: 0 }).registerForEvent('event-id', 'student', 'school-a'), error => error.code === 'organizer_registration');
  await assert.rejects(makeRepo({ taken: 0, existing: [{ status: 'confirmed' }] }).registerForEvent('event-id', 'student', 'school-a'), error => error.code === 'already_registered');
  await assert.rejects(makeRepo({ taken: 0 }).registerForEvent('event-id', 'student', 'school-b'), error => error.code === 'school_mismatch');
  assert.deepEqual(options, [], 'rejected capacity transactions must not be retried');
});

test('event cancellation and organizer review surface YDB serialization conflicts without retrying', async () => {
  const options = [];
  const makeRepo = status => {
    const tx = async strings => {
      const text = strings.join('');
      if (text.includes('FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'student', active: true }]];
      if (text.includes('FROM fam_listings')) return [[{ user_id: 'organizer', school_id: 'school-a', is_event: true }]];
      if (text.includes('FROM fam_event_registrations')) return [[{ status }]];
      if (text.includes('FROM fam_event_occupancy')) return [[{ taken: 1 }]];
      return [[]];
    };
    const sql = Object.assign(async () => [[]], { begin: async (settings, work) => {
      if (typeof settings === 'function') return settings(tx);
      options.push(settings);
      return work(tx);
    } });
    return createYdbListingsRepository(sql);
  };
  assert.equal(await makeRepo('confirmed').cancelEventRegistration('event-id', 'student-id'), true);
  assert.equal(await makeRepo('pending').moderateEventRegistration(
    'event-id', 'student-id', 'organizer', 'school-a', 'rejected'), true);
  assert.deepEqual(options, []);
});

test('event review allows its owner or an active same-school reviewer only', async () => {
  const makeRepo = ({ moderatorId, profileSchool = 'school-a', role = 'student', active = true, ownerId = 'organizer' }) => {
    const calls = [];
    const tx = async (strings, ...values) => {
      const text = strings.join('?'); calls.push({ text, values });
      if (text.includes('FROM fam_user_profiles')) return [[{ school_id: profileSchool, role, active }]];
      if (text.includes('FROM fam_listings')) return [[{ user_id: ownerId, school_id: 'school-a', is_event: true }]];
      if (text.includes('FROM fam_event_registrations')) return [[{ status: 'pending' }]];
      if (text.includes('FROM fam_event_occupancy')) return [[{ taken: 1 }]];
      return [[]];
    };
    const sql = Object.assign(async () => [[]], { begin: async (settings, work) =>
      (typeof settings === 'function' ? settings : work)(tx) });
    return { repo: createYdbListingsRepository(sql), calls };
  };
  const owner = makeRepo({ moderatorId: 'organizer' });
  assert.equal(await owner.repo.moderateEventRegistration('event-id', 'applicant', 'organizer', 'school-a', 'confirmed'), true);
  const otherStudent = makeRepo({ moderatorId: 'student' });
  assert.equal(await otherStudent.repo.moderateEventRegistration('event-id', 'applicant', 'student', 'school-a', 'confirmed'), false);
  const schoolCouncil = makeRepo({ moderatorId: 'council', role: 'council_member' });
  assert.equal(await schoolCouncil.repo.moderateEventRegistration('event-id', 'applicant', 'council', 'school-a', 'confirmed'), true);
  const crossSchoolCouncil = makeRepo({ moderatorId: 'council', profileSchool: 'school-b', role: 'council_member' });
  assert.equal(await crossSchoolCouncil.repo.moderateEventRegistration('event-id', 'applicant', 'council', 'school-a', 'confirmed'), false);
  const inactiveCouncil = makeRepo({ moderatorId: 'council', role: 'council_member', active: false });
  assert.equal(await inactiveCouncil.repo.moderateEventRegistration('event-id', 'applicant', 'council', 'school-a', 'confirmed'), false);
  assert.ok(schoolCouncil.calls[0].text.includes('active'));
  assert.ok(schoolCouncil.calls[0].values.includes('council'));
});

test('event occupancy query includes active status and authenticated school scope', async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(text.includes('INNER JOIN fam_listings')
      ? [[{ taken: 2 }]] : [[]]);
  };
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.getPublicEventOccupancy('active-event-id', 'school-a'), 2);
  assert.deepEqual(calls[0].values, ['active-event-id', 'school-a']);
  assert.match(calls[0].text, /INNER JOIN fam_listings AS l ON l\.id = o\.event_id/);
  assert.match(calls[0].text, /l\.school_id = \? AND l\.is_event = true AND l\.status = 'active'/);
  const hiddenSql = strings => Promise.resolve([[]]);
  assert.equal(await createYdbListingsRepository(hiddenSql).getPublicEventOccupancy('inactive-event-id', 'school-a'), null);
  await assert.rejects(repo.getPublicEventOccupancy('', 'school-a'), TypeError);
  await assert.rejects(repo.getPublicEventOccupancy('event-id', ''), TypeError);
});


test('school report metrics include high safety signals and pending rule proposals, scoped to one school', async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    const count = text.includes("severity = 'high'") ? 1
      : text.includes('fam_safety_incidents') ? 3
        : text.includes('fam_agent_ideas') ? 4 : 2;
    return [[{ count }]];
  };
  const repository = createYdbListingsRepository(sql);
  const metrics = await repository.getSchoolAgentMetrics('school-a');
  const pending = await repository.countPendingSchoolAgentIdeas('school-a');
  assert.equal(metrics.safety.unreviewed, 3);
  assert.equal(metrics.safety.high_unreviewed, 1);
  assert.equal(metrics.ideas.awaiting_council, 2);
  assert.equal(pending, 4);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(call => call.values.includes('school-a')));
  assert.ok(calls.some(call => call.text.includes("severity = 'high'")));
  assert.ok(calls.some(call => call.text.includes("fam_agent_ideas WHERE school_id = ? AND status = 'pending'")));
});

test('own idea history is bounded and scopes both ideas and image counts to the actor school', async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('FROM fam_ideas')) return [[{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Синтетическая идея',
      image_status: 'pending', ai_status: 'approved', admin_status: 'new', created_at: new Date('2026-11-20T12:00:00Z'),
    }]];
    if (text.includes('FROM fam_idea_images')) return [[{ image_index: 0 }, { image_index: 1 }]];
    return [[]];
  };
  const ideas = await createYdbListingsRepository(sql).listOwnIdeas(
    '11111111-1111-4111-8111-111111111111', 'school-a');
  assert.deepEqual(ideas, [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Синтетическая идея',
    image_status: 'pending', ai_status: 'approved', admin_status: 'new',
    created_at: new Date('2026-11-20T12:00:00Z'), image_count: 2,
  }]);
  const ownQuery = calls.find(call => call.text.includes('FROM fam_ideas'));
  assert.match(ownQuery.text, /user_id = \?/);
  assert.match(ownQuery.text, /school_id = \?/);
  assert.match(ownQuery.text, /LIMIT 50/);
  assert.ok(ownQuery.values.includes('11111111-1111-4111-8111-111111111111'));
  const imageQuery = calls.find(call => call.text.includes('FROM fam_idea_images'));
  assert.match(imageQuery.text, /user_id = \?/);
  assert.match(imageQuery.text, /school_id = \?/);
  assert.ok(imageQuery.values.includes('school-a'));
});
