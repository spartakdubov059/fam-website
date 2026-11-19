import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
import { getSiteErrorDigestSlot } from '../services/site-error-digest.mjs';

test('site error digest slot uses UTC quarter hours and rejects invalid dates', () => {
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:29:59.999Z')), '2026-11-18T06:15');
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:30:00.000Z')), '2026-11-18T06:30');
  assert.throws(() => getSiteErrorDigestSlot(new Date('invalid')), /invalid site error digest time/);
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
  const slot = '2026-11-18T06:15';
  const summary = 'Проверка ошибок FAM: агрегированные данные.';
  const metrics = { total_events_24h: 9, events_last_hour: 2,
    events: [{ event_code: 'js_runtime', page_area: 'other', occurrences: 9 }] };
  const repo = createYdbListingsRepository(async () => [[{ digest_slot: slot,
    generated_at: new Date('2026-11-18T06:16:00.000Z'), metrics_json: JSON.stringify(metrics), summary }]]);
  assert.deepEqual(await repo.getLatestSiteErrorDigest(), { digest_slot: slot,
    generated_at: new Date('2026-11-18T06:16:00.000Z'), metrics, summary });
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

test('safety signal writer stores only keyed metadata and never an evidence excerpt', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => { query = { text: strings.join('?'), values }; return Promise.resolve([[]]); });
  assert.equal(await repo.recordSafetySignal({ schoolId: 'school-a', fingerprint: 'a'.repeat(64), sourceKind: 'message',
    category: 'threat_or_intimidation', severity: 'high', actorId: '11111111-1111-4111-8111-111111111111',
    targetId: '22222222-2222-4222-8222-222222222222', sourceOrigin: 'messages' }), true);
  assert.match(query.text, /INSERT INTO fam_safety_incidents/);
  assert.match(query.text, /evidence_excerpt\)\s+VALUES/);
  assert.ok(query.values.includes('school-a') && query.values.includes('a'.repeat(64)));
  assert.equal(query.values.includes('текст угрозы'), false);
  assert.equal(query.text.includes('текст угрозы'), false);
  assert.ok(query.text.includes('NULL'), 'review fields and excerpt are null');
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

test('school idea review listing excludes the current reviewer own submission', async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_ideas')) return [[{ id: 'idea-a', school_id: 'school-a', text: 'Синтетическая идея', image_status: 'pending' }]];
    if (text.includes('FROM fam_idea_images')) return [[{ object_key: 'pending/user-id/photo.webp' }]];
    return [[]];
  };
  const reviewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ideas = await createYdbListingsRepository(sql).listPendingSchoolIdeas('school-a', reviewerId);
  assert.deepEqual(ideas, [{ id: 'idea-a', school_id: 'school-a', text: 'Синтетическая идея',
    image_status: 'pending', image_keys: ['pending/user-id/photo.webp'] }]);
  const queue = calls.find(call => call.text.includes('FROM fam_ideas'));
  assert.match(queue.text, /user_id != \?/);
  assert.ok(queue.values.includes('school-a'));
  assert.ok(queue.values.includes(reviewerId));
  assert.ok(calls.some(call => call.text.includes('FROM fam_idea_images') && call.values.includes('idea-a')));
});

test('school idea text review is same-school, excludes self review and audits a bounded decision', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'council_member', active: true }]];
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
  const audit = calls.find(call => call.text.includes('INSERT INTO fam_school_content_audit'));
  assert.ok(audit);
  assert.ok(audit.values.includes('idea_text_rejected'));
  assert.ok(!audit.values.includes('Синтетическая идея'));
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
  const result = await repo.updateOwnProfileIdentity('https://issuer.test', 'student-sub', { first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'student', staff_position: '' });
  assert.equal(result.first_name, 'Аня');
  const update = calls.find(call => call.text.includes('UPDATE fam_user_profiles'));
  assert.ok(update.values.includes('Аня')); assert.ok(update.values.includes('Иванова')); assert.ok(update.values.includes('8А'));
  assert.ok(update.values.includes('https://issuer.test')); assert.ok(update.values.includes('student-sub'));
  assert.ok(update.values.includes('student'));
  assert.match(update.text, /user_id = \? AND active = true/);
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
  assert.equal(await repo.finishPendingImageCleanup(key, claims[0].claim_token, false), true);
  assert.ok(calls.some(call => call.text.includes("SET status = 'pending', claim_token = ''")));
  assert.equal(await repo.finishPendingImageCleanup(key, claims[0].claim_token, true), true);
  await assert.rejects(repo.claimExpiredPendingImages(101), TypeError);
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
    if (query.text.includes('FROM fam_user_profiles')) return Promise.resolve([[{ user_id: 'recipient-id' }]]);
    return Promise.resolve([[]]);
  };
  const repo = createYdbListingsRepository(sql);
  const result = await repo.createMessage({ sender_id: 'sender-id', receiver_id: 'recipient-id', school_id: 'school-id', listing_id: 'listing-id', body: 'Привет' });
  assert.ok(calls.some(call => call.text.includes('listing_id') && call.values.includes('listing-id')));
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.ok(calls[0].values.includes('school-id'));
  assert.ok(calls[0].values.includes('recipient-id'));
  assert.ok(calls[1].values.includes('Привет'));

  let inserts = 0;
  const absent = createYdbListingsRepository((strings) => {
    if (strings.join('').includes('FROM fam_user_profiles')) return Promise.resolve([[]]);
    inserts++;
    return Promise.resolve([[]]);
  });
  await assert.rejects(absent.createMessage({ sender_id: 'sender-id', receiver_id: 'outside-school', school_id: 'school-id', body: 'Привет' }), error => error.code === 'recipient_unavailable');
  assert.equal(inserts, 0);
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

test('mark-read checks recipient and school before updating the message', async () => {
  const calls = [];
  const sql = (strings, ...values) => {
    const query = { text: strings.join('?'), values }; calls.push(query);
    return Promise.resolve(calls.length === 1 ? [[{ id: 'message-id' }]] : [[]]);
  };
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.markMessageRead('recipient-id', 'school-id', 'message-id'), true);
  assert.ok(calls[0].values.includes('recipient-id'));
  assert.ok(calls[0].values.includes('school-id'));
  assert.match(calls[1].text, /SET is_read = true/);

  let writes = 0;
  const absent = createYdbListingsRepository(() => { writes++; return Promise.resolve([[]]); });
  assert.equal(await absent.markMessageRead('other-user', 'school-id', 'message-id'), false);
  assert.equal(writes, 1);
});

test('listing moderation checks school and pending state in one transaction before changing status', async () => {
  const operations = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); operations.push({ text, values });
    return text.includes('SELECT school_id') ? [[{ school_id: 'school-a', status: 'pending', image_key: '', photo_status: 'none' }]] : [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.moderateListing('listing-id', 'school-a', 'active'), true);
  assert.match(operations[0].text, /SELECT school_id, status, image_key, photo_status/);
  assert.match(operations[1].text, /SET status = \?/);
  assert.deepEqual(operations[1].values, ['active', 'listing-id']);
  const photoPending = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(async (strings) => strings.join('').includes('SELECT school_id') ? [[{ school_id: 'school-a', status: 'pending', image_key: 'pending/key.webp', photo_status: 'pending' }]] : [[]]) }));
  assert.equal(await photoPending.moderateListing('photo-listing', 'school-a', 'active'), false, 'photo listings stay pending before photo approval');
  for (const row of [{ school_id: 'school-b', status: 'pending', image_key: '', photo_status: 'none' }, { school_id: 'school-a', status: 'active', image_key: '', photo_status: 'none' }, null]) {
    const blockedTx = async (strings) => strings.join('').includes('SELECT school_id') ? [[row].filter(Boolean)] : [[]];
    const blocked = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(blockedTx) }));
    assert.equal(await blocked.moderateListing('listing-id', 'school-a', 'rejected'), false);
  }
  await assert.rejects(repo.moderateListing('listing-id', 'school-a', 'pending'), TypeError);
});

test('event applicant query binds event and school and exposes only profile display fields', async () => {
  let query;
  const sql = async (strings, ...values) => { query = { text: strings.join('?'), values }; return [[{ user_id: 'u1', first_name: 'Аня', class_name: '8А', status: 'pending' }]]; };
  const repo = createYdbListingsRepository(sql);
  const rows = await repo.listEventApplicants('event-1', 'school-a');
  assert.equal(rows[0].user_id, 'u1');
  assert.ok(query.values.includes('event-1'));
  assert.ok(query.values.includes('school-a'));
  assert.match(query.text, /r\.school_id = \?/);
  assert.match(query.text, /l\.status = 'active'/);
  assert.doesNotMatch(query.text, /email|phone|address/i);
  await assert.rejects(repo.listEventApplicants('event-1', ''), TypeError);
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
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); operations.push({ text, values });
    if (text.includes('FROM fam_listings')) return [[{ user_id: 'organizer', school_id: 'school-a', is_event: true, status: 'active', event_type: 'limited', max_seats: 1 }]];
    if (text.includes('FROM fam_event_registrations')) return [[]];
    if (text.includes('FROM fam_event_occupancy')) return [[{ taken: 0 }]];
    return [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.deepEqual(await repo.registerForEvent('event-id', 'verified-user'), { event_id: 'event-id', user_id: 'verified-user', status: 'confirmed' });
  assert.ok(operations.some(operation => operation.text.includes('UPSERT INTO fam_event_occupancy')));
  const registration = operations.find(operation => operation.text.includes('UPSERT INTO fam_event_registrations'));
  assert.ok(registration.values.includes('verified-user'));
  assert.equal(registration.text.includes('forged-user'), false);
});

test('event capacity and organizer rejection are returned after the YDB transaction instead of aborting it', async () => {
  const makeRepo = ({ owner = 'organizer', taken = 1, existing = [] } = {}) => {
    const tx = async strings => {
      const text = strings.join('');
      if (text.includes('FROM fam_listings')) return [[{ user_id: owner, school_id: 'school-a', is_event: true, status: 'active', event_type: 'limited', max_seats: 1 }]];
      if (text.includes('FROM fam_event_registrations')) return [existing];
      if (text.includes('FROM fam_event_occupancy')) return [[{ taken }]];
      return [[]];
    };
    return createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(tx) }));
  };
  await assert.rejects(makeRepo().registerForEvent('event-id', 'student'), error => error.code === 'no_seats_available');
  await assert.rejects(makeRepo({ owner: 'student', taken: 0 }).registerForEvent('event-id', 'student'), error => error.code === 'organizer_registration');
  await assert.rejects(makeRepo({ taken: 0, existing: [{ status: 'confirmed' }] }).registerForEvent('event-id', 'student'), error => error.code === 'already_registered');
});
