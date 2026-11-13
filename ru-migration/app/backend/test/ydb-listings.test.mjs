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
