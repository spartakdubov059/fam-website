import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
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
