import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
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
test('profile identity update changes only first name, last name, and class for its issuer/subject key', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT user_id, active FROM fam_user_profiles')) return [[{ user_id: 'synthetic-user', active: true }]];
    if (text.includes('SELECT user_id AS id, school_id')) return [[{ id: 'synthetic-user', school_id: 'school-a', role: 'student', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: callback => callback(tx) });
  const repo = createYdbListingsRepository(sql);
  const result = await repo.updateOwnProfileIdentity('https://issuer.test', 'student-sub', { first_name: 'Аня', last_name: 'Иванова', class_name: '8А' });
  assert.equal(result.first_name, 'Аня');
  const update = calls.find(call => call.text.includes('UPDATE fam_user_profiles'));
  assert.ok(update.values.includes('Аня')); assert.ok(update.values.includes('Иванова')); assert.ok(update.values.includes('8А'));
  assert.ok(update.values.includes('https://issuer.test')); assert.ok(update.values.includes('student-sub'));
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
  let query;
  const sql = async (strings, ...values) => { query = { text: strings.join('?'), values }; };
  const repo = createYdbListingsRepository(sql);
  const payload = "Книга'); DELETE FROM fam_listings; --";
  const row = { user_id: 'u1', school_id: 's1', title: payload, description: 'text', category: 'Учёба', price_text: '100 ₽', is_event: false, event_date: null, event_time: null, event_type: null, max_seats: 0, image_key: null, photo_status: 'none', status: 'pending' };
  const result = await repo.createListing(row);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(query.text.includes(payload), false);
  assert.ok(query.values.includes(payload));
  assert.ok(query.values.includes(''));
  assert.ok(query.values.includes('none'));
  await assert.rejects(repo.createListing({ ...row, status: 'active' }));
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
  const result = await repo.createMessage({ sender_id: 'sender-id', receiver_id: 'recipient-id', school_id: 'school-id', body: 'Привет' });
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
