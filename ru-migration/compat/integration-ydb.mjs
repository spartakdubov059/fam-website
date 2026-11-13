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
  console.log('YDB_LOCAL_INTEGRATION_PASS: profile lookup, pending isolation, approved listing projection, favorites and read on disposable local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  await driver.close();
}
