import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
import { createSuspensionWriteGuard } from '../app/backend/auth/suspension-write-guard.mjs';
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
    ('https://issuer.synthetic', 'subject-3', '22222222-2222-4222-8222-222222222222', 'other-school', 'student', true),
    ('https://issuer.synthetic', 'subject-lyceum-admin', '44444444-4444-4444-8444-444444444444', 'lyceum_3', 'school_admin', true);`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
  const authenticate = async req => ({ issuer: 'https://issuer.synthetic', subject: req.headers.authorization === 'Bearer synthetic-admin' ? 'subject-admin'
      : req.headers.authorization === 'Bearer synthetic-registrant' ? 'subject-2'
        : req.headers.authorization === 'Bearer synthetic-new-student' ? 'subject-new'
          : req.headers.authorization === 'Bearer synthetic-lyceum-admin' ? 'subject-lyceum-admin' : 'subject-1' });
  const listingsApi = createSuspensionWriteGuard({ authenticate, resolveActor, repository: repo })(createListingsApi({
    authenticate,
    resolveActor,
    repository: repo,
  }));
  const apiRequest = (method, url, token, body = {}) => {
    const request = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = method; request.url = url; request.headers = { authorization: `Bearer ${token}` };
    return request;
  };
  const profileSubmission = await listingsApi(apiRequest('POST', '/api/v1/profile-requests', 'synthetic-new-student', {
    school_id: 'lyceum_3', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б', role: 'school_admin',
  }));
  assert.equal(profileSubmission.status, 202);
  assert.equal(profileSubmission.body.status, 'pending');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new' }), null,
    'an access request alone never creates a profile');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-student'))).status, 403,
    'students cannot read access requests');
  const profileQueue = await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-lyceum-admin'));
  assert.equal(profileQueue.status, 200);
  const profileRequest = profileQueue.body.requests.find(row => row.first_name === 'Тест' && row.last_name === 'Профиль');
  assert.ok(profileRequest);
  assert.equal(Object.hasOwn(profileRequest, 'subject'), false, 'review queue omits external identity subjects');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${profileRequest.request_id}`, 'synthetic-admin', { decision: 'approve' }))).status, 404,
    'an administrator from another school cannot approve the request');
  const profileDecision = await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${profileRequest.request_id}`, 'synthetic-lyceum-admin', { decision: 'approve' }));
  assert.deepEqual(profileDecision, { status: 200, body: { ok: true, status: 'approved' } });
  const approvedActor = await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new' });
  assert.ok(approvedActor);
  assert.match(approvedActor.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ school_id: approvedActor.school_id, role: approvedActor.role, first_name: approvedActor.first_name,
    last_name: approvedActor.last_name, class_name: approvedActor.class_name }, {
    school_id: 'lyceum_3', role: 'student', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б',
  });
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
  const listing = await repo.createListing({ user_id: 'synthetic-user', school_id: 'synthetic-school', title,
    description: 'Учебник', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
    event_date: null, event_time: null, event_type: null, max_seats: 0, status: 'pending' });
  const sets = await sql`SELECT id, user_id, school_id, title, status FROM fam_listings WHERE id = ${listing.id};`;
  assert.equal(sets[0].length, 1);
  assert.equal(sets[0][0].title, title);
  assert.equal(sets[0][0].user_id, 'synthetic-user');
  assert.equal(sets[0][0].school_id, 'synthetic-school');
  assert.equal(sets[0][0].status, 'pending');
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, true), false, 'pending listings cannot be favorited');
  const beforeDirectModeration = await repo.listActiveListings();
  assert.equal(beforeDirectModeration.length, 1, 'only the separately API-approved item is public');
  assert.equal(beforeDirectModeration.some(row => row.id === listing.id), false, 'pending content must not appear publicly');
  assert.equal(await repo.moderateListing(listing.id, 'other-school', 'active'), false, 'other school cannot moderate');
  assert.equal(await repo.moderateListing(listing.id, 'synthetic-school', 'active'), true, 'school moderator can approve pending listing');
  const publicListings = await repo.listActiveListings();
  assert.equal(publicListings.length, 2);
  const publicDirectListing = publicListings.find(row => row.id === listing.id);
  assert.ok(publicDirectListing);
  assert.equal(await repo.getListingContactRecipient(listing.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school'), 'synthetic-user',
    'a same-school member can contact the owner of an active listing');
  assert.equal(await repo.getListingContactRecipient(listing.id, 'synthetic-user', 'synthetic-school'), null,
    'listing owners cannot open a self-conversation');
  assert.equal(await repo.getListingContactRecipient(listing.id, '11111111-1111-4111-8111-111111111111', 'other-school'), null,
    'listing contact lookup cannot cross school boundaries');
  assert.equal(publicDirectListing.title, title);
  assert.equal(Object.hasOwn(publicDirectListing, 'user_id'), false);
  assert.equal(Object.hasOwn(publicDirectListing, 'school_id'), false);
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, true), true);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), [listing.id]);
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, false), true);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), []);
  const idea = await repo.createIdea({ user_id: 'synthetic-user', school_id: 'synthetic-school',
    text: 'Синтетическая идея книжного обмена', ai_status: 'pending', ai_summary: 'Синтетическая идея',
    ai_reason: 'review_unavailable', admin_status: 'new' });
  const ideaRows = await sql`SELECT user_id, school_id, text, ai_status, admin_status FROM fam_ideas WHERE id = ${idea.id};`;
  assert.equal(ideaRows[0][0].user_id, 'synthetic-user');
  assert.equal(ideaRows[0][0].school_id, 'synthetic-school');
  assert.equal(ideaRows[0][0].ai_status, 'pending');
  assert.equal(ideaRows[0][0].admin_status, 'new');
  const message = await repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school', body: 'Синтетическое одобренное сообщение' });
  const messageRows = await sql`SELECT sender_id, receiver_id, school_id, body, is_read FROM fam_messages WHERE id = ${message.id};`;
  assert.equal(messageRows[0][0].receiver_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(messageRows[0][0].school_id, 'synthetic-school');
  assert.equal(messageRows[0][0].is_read, false);
  assert.deepEqual((await repo.listMessages('synthetic-user', 'synthetic-school')).map(row => row.id), [message.id]);
  assert.deepEqual(await repo.listMessages('unrelated-user', 'synthetic-school'), []);
  assert.equal(await repo.markMessageRead('synthetic-user', 'synthetic-school', message.id), false, 'sender cannot mark the recipient inbox as read');
  assert.equal(await repo.markMessageRead('11111111-1111-4111-8111-111111111111', 'synthetic-school', message.id), true);
  const readRows = await sql`SELECT is_read FROM fam_messages WHERE id = ${message.id};`;
  assert.equal(readRows[0][0].is_read, true);
  await assert.rejects(repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '22222222-2222-4222-8222-222222222222', school_id: 'synthetic-school', body: 'cross-school synthetic' }), error => error.code === 'recipient_unavailable');

  const limitedEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическая встреча с ограниченным числом мест', description: 'Проверка атомарной записи', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-01', event_time: '12:00', event_type: 'limited', max_seats: 1, status: 'pending' });
  assert.equal(await repo.moderateListing(limitedEvent.id, 'synthetic-school', 'active'), true);
  const eventApiRequest = apiRequest('POST', `/api/v1/listings/${limitedEvent.id}/registrations`, 'synthetic-registrant', null);
  const registrationResponse = await listingsApi(eventApiRequest);
  assert.equal(registrationResponse.status, 201);
  assert.equal(registrationResponse.body.registration.status, 'confirmed');
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 1);
  await assert.rejects(repo.registerForEvent(limitedEvent.id, '22222222-2222-4222-8222-222222222222'), error => error.code === 'no_seats_available');
  assert.equal(await repo.cancelEventRegistration(limitedEvent.id, '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 0);
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/event-registrations', 'synthetic-registrant'))).body.registrations
    .filter(row => row.event_id === limitedEvent.id).map(row => row.status), ['cancelled']);

  const concurrentEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое мероприятие для гонки за местом', description: 'Параллельная проверка вместимости', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-03', event_time: '12:00', event_type: 'limited', max_seats: 1, status: 'pending' });
  assert.equal(await repo.moderateListing(concurrentEvent.id, 'synthetic-school', 'active'), true);
  const concurrentAttempts = await Promise.allSettled([
    repo.registerForEvent(concurrentEvent.id, '11111111-1111-4111-8111-111111111111'),
    repo.registerForEvent(concurrentEvent.id, '22222222-2222-4222-8222-222222222222'),
  ]);
  assert.equal(concurrentAttempts.filter(result => result.status === 'fulfilled').length, 1,
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
  const reviewQueue = await listingsApi(apiRequest('GET', '/api/v1/event-registrations/review', 'synthetic-admin'));
  assert.equal(reviewQueue.status, 200);
  assert.equal(reviewQueue.body.applications.some(row => row.event_id === reviewEvent.id && row.user_id === '11111111-1111-4111-8111-111111111111'), true,
    'same-school moderator can see the synthetic pending registration');
  assert.equal(reviewQueue.body.applications.some(row => row.user_id === '22222222-2222-4222-8222-222222222222'), false,
    'event review queue excludes registrations from other schools');
  const studentReviewQueue = await listingsApi(apiRequest('GET', '/api/v1/event-registrations/review', 'synthetic-student'));
  assert.equal(studentReviewQueue.status, 403, 'students cannot read the event review queue');
  assert.equal(await repo.moderateEventRegistration(reviewEvent.id, '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'other-school', 'confirmed'), false,
    'event registration review is scoped to the event owner school');
  const reviewResponse = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${reviewEvent.id}/registrations/11111111-1111-4111-8111-111111111111`, 'synthetic-admin', { decision: 'reject' }));
  assert.deepEqual(reviewResponse, { status: 200, body: { ok: true, status: 'rejected' } });
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 0, 'rejecting a pending request releases its reserved seat');
  await sql`UPSERT INTO fam_account_suspensions
    (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at)
    VALUES ('synthetic-school', 'synthetic-user', 'synthetic-suspension', 'student', 24,
      'Synthetic integration suspension', 'active', 'synthetic-admin', CurrentUtcTimestamp(),
      Unwrap(CurrentUtcTimestamp() + Interval('PT24H')));`;
  const suspendedWrite = await listingsApi(apiRequest('POST', '/api/v1/listings', 'synthetic-user', {
    title: 'Не должно сохраниться', description: 'Synthetic suspension guard', category: 'Учёба',
  }));
  assert.equal(suspendedWrite.status, 403, 'active account suspension blocks authenticated writes');
  assert.equal(suspendedWrite.body.error, 'account_suspended');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/listings', 'synthetic-user'))).status, 200,
    'account suspension leaves read access available');
  assert.equal((await repo.getActiveAccountSuspension('synthetic-school', 'synthetic-user'))?.reason,
    'Synthetic integration suspension');
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
  console.log('YDB_LOCAL_INTEGRATION_PASS: profiles, school profile-request approval, listings, favorites, ideas, messages, school-scoped photo/event review queues, photo visibility gate, event capacity/cancellation/review on disposable local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
