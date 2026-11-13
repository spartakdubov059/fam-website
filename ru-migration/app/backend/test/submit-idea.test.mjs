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
