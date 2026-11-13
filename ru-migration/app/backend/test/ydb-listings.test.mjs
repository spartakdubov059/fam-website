import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
test('listing insert binds user content as data and writes only pending status', async () => {
  let query;
  const sql = async (strings, ...values) => { query = { text: strings.join('?'), values }; };
  const repo = createYdbListingsRepository(sql);
  const payload = "Книга'); DELETE FROM fam_listings; --";
  const row = { user_id: 'u1', school_id: 's1', title: payload, description: 'text', category: 'Учёба', price_text: '100 ₽', is_event: false, event_date: null, event_time: null, event_type: null, max_seats: 0, status: 'pending' };
  const result = await repo.createListing(row);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(query.text.includes(payload), false);
  assert.ok(query.values.includes(payload));
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
