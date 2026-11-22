Warning: truncated output (original token count: 21936)
Total output lines: 1342

import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
import { getSiteErrorDigestSlot } from '../services/site-error-digest.mjs';

test('site error digest slot uses UTC quarter hours and rejects invalid dates', () => {
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:29:59.999Z')), '2026-11-18T06:15');
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
  await assert.rejects(repo.getActiveAccountSuspension('', 'student-a'), TypeEr…15936 tokens truncated…and school and exposes only profile display fields', async () => {
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
  assert.deepEqual(await repo.registerForEvent('event-id', 'verified-user'), { event_id: 'event-id', user_id: 'verified-user', status: 'confirmed' });
  assert.deepEqual(beginOptions, [{ idempotent: true }], 'capacity transactions retry serializable conflicts from a fresh snapshot');
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
  await assert.rejects(makeRepo().registerForEvent('event-id', 'student'), error => error.code === 'no_seats_available');
  await assert.rejects(makeRepo({ owner: 'student', taken: 0 }).registerForEvent('event-id', 'student'), error => error.code === 'organizer_registration');
  await assert.rejects(makeRepo({ taken: 0, existing: [{ status: 'confirmed' }] }).registerForEvent('event-id', 'student'), error => error.code === 'already_registered');
  assert.deepEqual(options, [{ idempotent: true }, { idempotent: true }, { idempotent: true }]);
});

test('event cancellation and organizer review retry after YDB serialization conflicts', async () => {
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
      options.push(settings);
      return work(tx);
    } });
    return createYdbListingsRepository(sql);
  };
  assert.equal(await makeRepo('confirmed').cancelEventRegistration('event-id', 'student-id'), true);
  assert.equal(await makeRepo('pending').moderateEventRegistration(
    'event-id', 'student-id', 'organizer', 'school-a', 'rejected'), true);
  assert.deepEqual(options, [{ idempotent: true }, { idempotent: true }]);
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
    const sql = Object.assign(async () => [[]], { begin: async (settings, work) => work(tx) });
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
