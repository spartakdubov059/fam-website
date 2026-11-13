import test from 'node:test';
import assert from 'node:assert/strict';
import { submitMessage } from '../services/submit-message.mjs';

const actor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a', role: 'student' };
const input = { receiver_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', body: 'Привет, как дела?' };

test('message is not sent or stored while moderation is unavailable', async () => {
  let writes = 0;
  const result = await submitMessage({ actor, input, repository: { createMessage: async () => { writes++; return { id: 'unexpected' }; } } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'pending');
  assert.equal(writes, 0);
});

test('only an explicit moderation approval can insert a message', async () => {
  let record;
  const result = await submitMessage({ actor, input, review: async () => ({ action: 'ok' }),
    repository: { createMessage: async value => { record = value; return { id: 'synthetic-message' }; } } });
  assert.deepEqual(record, { sender_id: actor.id, receiver_id: input.receiver_id, school_id: actor.school_id, body: input.body });
  assert.deepEqual(result, { ok: true, status: 'approved', id: 'synthetic-message' });
});

test('message rejects self-send, malformed recipients and contact details before review', async () => {
  let reviews = 0;
  const options = { actor, review: async () => { reviews++; return { action: 'ok' }; }, repository: { createMessage: async () => ({ id: 'unexpected' }) } };
  assert.equal((await submitMessage({ ...options, input: { ...input, receiver_id: actor.id } })).code, 'invalid_message');
  assert.equal((await submitMessage({ ...options, input: { ...input, receiver_id: 'not-a-uuid' } })).code, 'invalid_message');
  assert.equal((await submitMessage({ ...options, input: { ...input, body: 'Пиши на test@example.ru' } })).code, 'personal_contact_data');
  assert.equal(reviews, 0);
});

test('message rejects profiles without a school', async () => {
  const result = await submitMessage({ actor: { ...actor, school_id: '' }, input, repository: {} });
  assert.equal(result.code, 'school_required');
});
