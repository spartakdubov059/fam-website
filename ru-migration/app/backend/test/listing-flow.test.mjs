import test from 'node:test';
import assert from 'node:assert/strict';
import { submitListing } from '../services/submit-listing.mjs';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
const actor = { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' };
const input = { title: 'Книга', description: 'Учебник', category: 'Учёба', price_text: '100 ₽', user_id: 'other' };
const review = async () => ({ action: 'ok' });
test('submission passes server identity and pending status to the parameterized insert', async () => {
  let calls = 0, captured;
  const sql = async (strings, ...values) => { calls++; captured = { text: strings.join('?'), values }; };
  const result = await submitListing({ actor, input, review, repository: createYdbListingsRepository(sql) });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.ok(captured.values.includes(actor.id));
  assert.ok(captured.values.includes(actor.school_id));
  assert.ok(captured.values.includes('pending'));
  assert.equal(captured.values.includes('other'), false);
  assert.equal(captured.text.includes(input.title), false);
});
test('failed database insert is surfaced and never reported as success', async () => {
  const sql = async () => { throw new Error('offline'); };
  const result = await submitListing({ actor, input, review, repository: createYdbListingsRepository(sql) });
  assert.deepEqual(result, { ok: false, code: 'database_unavailable' });
});
