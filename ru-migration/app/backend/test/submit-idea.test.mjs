import test from 'node:test';
import assert from 'node:assert/strict';
import { submitIdea } from '../services/submit-idea.mjs';

const actor = { id: 'synthetic-user', school_id: 'synthetic-school', role: 'student' };

test('idea with unavailable moderation is stored only as pending for the authenticated school profile', async () => {
  let saved;
  const result = await submitIdea({ actor, input: { text: 'Нужен школьный книжный обмен', user_id: 'forged' },
    repository: { createIdea: async value => { saved = value; return { id: 'synthetic-idea' }; } } });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'pending');
  assert.equal(saved.user_id, actor.id);
  assert.equal(saved.school_id, actor.school_id);
  assert.equal(saved.ai_status, 'pending');
  assert.equal(saved.admin_status, 'new');
});

test('idea submission rejects personal contact data before database storage', async () => {
  let writes = 0;
  const result = await submitIdea({ actor, input: { text: 'Напишите мне test@example.ru' },
    repository: { createIdea: async () => { writes++; return { id: 'unexpected' }; } } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'personal_contact_data');
  assert.equal(writes, 0);
});

test('idea submission requires a school and bounded text', async () => {
  assert.equal((await submitIdea({ actor: { ...actor, school_id: '' }, input: { text: 'Идея' }, repository: {} })).code, 'school_required');
  assert.equal((await submitIdea({ actor, input: { text: 'x' }, repository: {} })).code, 'invalid_idea');
  assert.equal((await submitIdea({ actor, input: { text: 'a'.repeat(1001) }, repository: {} })).code, 'invalid_idea');
});

test('idea images accept at most three own pending WebP keys and remain pending for school review', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const keys = [1, 2, 3].map((_, index) => `pending/${userId}/${index + 1}1111111-1111-4111-8111-111111111111.webp`);
  let saved;
  const result = await submitIdea({ actor: { ...actor, id: userId }, input: { text: 'Оформим библиотеку школы', image_keys: keys },
    review: async () => ({ action: 'ok' }), repository: { createIdea: async value => { saved = value; return { id: 'idea-with-images' }; } } });
  assert.equal(result.ok, true);
  assert.equal(result.image_status, 'pending');
  assert.deepEqual(saved.image_keys, keys);
  assert.equal(saved.image_status, 'pending');
  for (const image_keys of [keys.slice(0, 2).concat(keys[0]), [...keys, keys[0]], ['pending/other-user/11111111-1111-4111-8111-111111111111.webp']]) {
    const invalid = await submitIdea({ actor: { ...actor, id: userId }, input: { text: 'Идея школы', image_keys }, repository: {} });
    assert.equal(invalid.code, 'invalid_idea');
  }
  const invalidActor = await submitIdea({ actor, input: { text: 'Идея школы', image_keys: [keys[0]] }, repository: {} });
  assert.equal(invalidActor.code, 'invalid_idea', 'image ownership path requires a UUID account id');
});

test('surfaces persistent idea quotas as a rate limit instead of a database failure', async () => {
  const result = await submitIdea({ actor, input: { text: 'Школьный книжный клуб' },
    repository: { createIdea: async () => { const error = new Error('limited'); error.code = 'rate_limited'; throw error; } } });
  assert.deepEqual(result, { ok: false, code: 'rate_limited' });
});
