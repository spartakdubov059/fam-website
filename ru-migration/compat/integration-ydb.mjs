Warning: truncated output (original token count: 3642)
Total output lines: 158

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
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
    ('https://issuer.synthetic', 'subject-3', '22222222-2222-4222-8222-222222222222', 'other-school', 'student', true);`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
  const listingsApi = createListingsApi({
    authenticate: async req => ({ issuer: 'https://issuer.synthetic', subject: req.headers.authorization === 'Bearer synthetic-admin' ? 'subject-admin'
      : req.headers.authorization === 'Bearer synthetic-registrant' ? 'subject-2' : 'subject-1' }),
    resolveActor,
    repository: repo,
  });
  const apiRequest = (method, url, token, body = {}) => {
    const request = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = method; request.url = url; request.headers = { authorization: `Bearer ${token}` };
    return request;
  };
  const apiSubmission = await listingsApi(apiRequest('POST', '/api/v1/listings', 'synthetic-student', {
    title: 'Обмен учебниками', description: 'Синтетическое объявление для интеграционной проверки', category: 'Учёба',
  }));
  assert.equal(apiSubmission.status, 201);
  assert.equal(apiSubmission.body.status, 'pending');
  assert.deepEqual(await repo.listActiveListings(), [], 'API submissions remain invisible before school moderation');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/listings/${apiSubmission.body.id}/moderation`, 'synthetic-student', { decision: 'approve' }))).status, 403,
    'student cannot moderate even when using a valid database-backed identity');
  const apiApproval = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${apiSubmission.body.id}/moderation`, 'synthetic-admin', { decision: 'approve' }));
  assert.deepEqual(apiApproval, { status: 200, body: { ok: true, status: 'active' } });
  assert.equal((await repo.listActiveListings()).length, 1, 'approved API submission becomes visible through public projection');
  const title = "Синтетическая книга'); DELETE FROM fam_listings; --";
  const listing = await repo.create…1642 tokens truncated…th, 1,
    'serializable capacity check permits at most one successful registration for the final seat');
  assert.equal(await repo.getEventOccupancy(concurrentEvent.id), 1, 'concurrent requests cannot overbook or lose the occupancy count');

  const reviewEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое мероприятие по заявкам', description: 'Проверка школьного решения', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-02', event_time: '12:00', event_type: 'request', max_seats: 0, status: 'pending' });
  assert.equal(await repo.moderateListing(reviewEvent.id, 'synthetic-school', 'active'), true);
  const requestResponse = await listingsApi(apiRequest('POST', `/api/v1/listings/${reviewEvent.id}/registrations`, 'synthetic-registrant', null));
  assert.equal(requestResponse.status, 201);
  assert.equal(requestResponse.body.registration.status, 'pending');
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 1);
  assert.equal(await repo.moderateEventRegistration(reviewEvent.id, '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'other-school', 'confirmed'), false,
    'event registration review is scoped to the event owner school');
  const reviewResponse = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${reviewEvent.id}/registrations/11111111-1111-4111-8111-111111111111`, 'synthetic-admin', { decision: 'reject' }));
  assert.deepEqual(reviewResponse, { status: 200, body: { ok: true, status: 'rejected' } });
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 0, 'rejecting a pending request releases its reserved seat');
  const photoListing = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое объявление с фото', description: 'Изображение остаётся закрытым до отдельного одобрения', category: 'Творчество',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    photo_status: 'pending', status: 'pending' });
  assert.equal(await repo.moderateListing(photoListing.id, 'synthetic-school', 'active'), false,
    'listing with pending photo cannot become public');
  assert.equal((await repo.listActiveListings()).some(row => row.id === photoListing.id), false,
    'pending photo listing remains absent from the public projection');
  const otherSchoolPending = await repo.createListing({ user_id: '22222222-2222-4222-8222-222222222222', school_id: 'other-school',
    title: 'Чужое школьное объявление', description: 'Не должно попасть в очередь', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, status: 'pending' });
  const moderationQueue = await listingsApi(apiRequest('GET', '/api/v1/listings/moderation', 'synthetic-admin'));
  assert.equal(moderationQueue.status, 200);
  assert.ok(moderationQueue.body.listings.some(row => row.id === photoListing.id), 'school queue includes its own pending photo listing');
  assert.ok(!moderationQueue.body.listings.some(row => row.id === otherSchoolPending.id), 'school queue excludes other-school listings');
  assert.equal(moderationQueue.body.listings.find(row => row.id === photoListing.id).photo_url, `/api/v1/listings/${photoListing.id}/photo`);
  console.log('YDB_LOCAL_INTEGRATION_PASS: profiles, listings, favorites, ideas, messages, school-scoped photo moderation queue, photo visibility gate, event capacity/cancellation/review on disposable local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
