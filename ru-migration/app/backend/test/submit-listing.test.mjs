import test from 'node:test';
import assert from 'node:assert/strict';
import { submitListing } from '../services/submit-listing.mjs';
const actor = { id: 'synthetic-user', school_id: 'school-1', role: 'student' };
const input = { title: 'Книга', description: 'Учебник математики', category: 'Учёба', user_id: 'attacker' };
const approve = async () => ({ action: 'ok' });
test('requires authentication and an available reviewer before any write', async () => {
  let writes = 0;
  const repository = { createListing: async () => { writes++; return { id: '1' }; } };
  assert.equal((await submitListing({ input, repository, review: approve })).code, 'unauthenticated');
  assert.equal((await submitListing({ actor, input, repository })).status, 'pending');
  assert.equal((await submitListing({ actor, input: { ...input, description: 'Пишите learner@example.ru' }, repository, review: approve })).code, 'personal_contact_data');
  assert.equal(writes, 0);
});
test('uses authenticated actor identity and never marks a listing active', async () => {
  let record;
  const repository = { createListing: async (r) => { record = r; return { id: 'new-id' }; } };
  assert.deepEqual(await submitListing({ actor, input, repository, review: approve }), { ok: true, status: 'pending', id: 'new-id' });
  assert.equal(record.user_id, actor.id);
  assert.equal(record.status, 'pending');
});
test('rejects image input and fails closed when storage fails', async () => {
  assert.equal((await submitListing({ actor, input: { ...input, image_url: 'https://example.com/x' }, review: approve })).code, 'invalid_listing');
  assert.equal((await submitListing({ actor, input, review: approve, repository: { createListing: async () => { throw Error('offline'); } } })).code, 'database_unavailable');
});

test('school and event privileges come from the server profile', async () => {
  const repository = { createListing: async () => ({ id: 'x' }) };
  assert.equal((await submitListing({ actor: { id: actor.id }, input, repository, review: approve })).code, 'school_required');
  assert.equal((await submitListing({ actor, input: { ...input, category: 'Мероприятия', role: 'school_admin' }, repository, review: approve })).code, 'forbidden');
});
test('price participates in privacy checks and is preserved', async () => {
  let record; const repository = { createListing: async (r) => { record = r; return { id: 'x' }; } };
  assert.equal((await submitListing({ actor, input: { ...input, price_text: 'learner@example.ru' }, repository, review: approve })).code, 'personal_contact_data');
  await submitListing({ actor, input: { ...input, price_text: '100 ₽' }, repository, review: approve });
  assert.equal(record.price_text, '100 ₽'); assert.equal(record.school_id, actor.school_id);
});
