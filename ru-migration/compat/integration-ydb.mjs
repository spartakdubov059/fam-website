import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';

// This script is intentionally hard-wired to the disposable local database.
const driver = new Driver('grpc://127.0.0.1:2136/local');
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => { const statement = client(strings, ...values); statement.on('error', () => {}); return statement; };
  const repo = createYdbListingsRepository(sql);
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name, city) VALUES ('https://issuer.synthetic', 'subject-1', 'synthetic-user', 'synthetic-school', 'student', true, 'Тест', 'Ученик', '8А', 'Казань');`;
  await sql`INSERT INTO fam_user_profiles (issuer, subject, user_id, school_id, role, active) VALUES
    ('https://issuer.synthetic', 'subject-2', '11111111-1111-4111-8111-111111111111', 'synthetic-school', 'student', true),
    ('https://issuer.synthetic', 'subject-3', '22222222-2222-4222-8222-222222222222', 'other-school', 'student', true);`;
  const resolveActor = createDatabaseActorResolver(sql);
  assert.deepEqual(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-1' }), { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student', first_name: 'Тест', last_name: 'Ученик', class_name: '8А', city: 'Казань', avatar_url: null });
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'unknown' }), null);
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
  assert.deepEqual(await repo.listActiveListings(), [], 'pending content must not appear publicly');
  await sql`UPDATE fam_listings SET status = 'active' WHERE id = ${listing.id};`;
  const publicListings = await repo.listActiveListings();
  assert.equal(publicListings.length, 1);
  assert.equal(publicListings[0].id, listing.id);
  assert.equal(publicListings[0].title, title);
  assert.equal(Object.hasOwn(publicListings[0], 'user_id'), false);
  assert.equal(Object.hasOwn(publicListings[0], 'school_id'), false);
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
  await assert.rejects(repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '22222222-2222-4222-8222-222222222222', school_id: 'synthetic-school', body: 'cross-school synthetic' }), error => error.code === 'recipient_unavailable');
  console.log('YDB_LOCAL_INTEGRATION_PASS: profile lookup, listings, favorites, pending idea and same-school approved message on disposable local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
