import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewIdeaText, reviewText } from '../policies/review-text.mjs';

test('personal contact data is rejected before invoking any reviewer', async () => {
  let called = false;
  const result = await reviewText('Позвоните +7 900 123-45-67', { review: async () => { called = true; return { action: 'ok' }; } });
  assert.equal(called, false);
  assert.deepEqual(result, { action: 'reject', reason_code: 'personal_contact_data' });
});
test('reviewer absence, failure and invalid results cannot approve content', async () => {
  for (const review of [undefined, async () => { throw new Error('offline'); }, async () => ({ action: 'unknown' })]) {
    assert.equal((await reviewText('Книги для школы', { review })).action, 'pending');
  }
});
test('valid reviewer receives a local flag and its decision is returned', async () => {
  let received;
  const result = await reviewText('Обсудим вред вейпов', { review: async (input) => { received = input; return { action: 'pending', reason_code: 'manual_review' }; } });
  assert.equal(received.localFlag, 'nicotine_or_alcohol');
  assert.deepEqual(result, { action: 'pending', reason_code: 'manual_review', local_flag: 'nicotine_or_alcohol' });
});
test('serious local flags remain available to the Russian incident writer after review', async () => {
  const result = await reviewText('Поступали угрозы в адрес ученика.', { review: async () => ({ action: 'pending' }) });
  assert.equal(result.action, 'pending');
  assert.equal(result.local_flag, 'serious_hate_or_threat');
});
test('empty and oversized input is rejected', async () => {
  assert.equal((await reviewText('   ')).reason_code, 'invalid_text');
  assert.equal((await reviewText('a'.repeat(10001))).reason_code, 'invalid_text');
});

test('idea fallback approves only unflagged text and preserves the source high-risk manual-review path', () => {
  assert.deepEqual(reviewIdeaText('Нужен школьный книжный обмен'),
    { action: 'ok', reason_code: 'safe_local_fallback', local_flag: null });
  assert.deepEqual(reviewIdeaText('В адрес ученика поступили угрозы.'),
    { action: 'pending', reason_code: 'serious_hate_or_threat', local_flag: 'serious_hate_or_threat' });
  assert.deepEqual(reviewIdeaText('Продажа вейпов у школы.'),
    { action: 'reject', reason_code: 'unsafe_content', local_flag: 'nicotine_or_alcohol' });
  assert.deepEqual(reviewIdeaText('Пишите test@example.ru'),
    { action: 'reject', reason_code: 'personal_contact_data', local_flag: null });
});
