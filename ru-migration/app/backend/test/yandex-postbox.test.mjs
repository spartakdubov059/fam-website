import test from 'node:test';
import assert from 'node:assert/strict';
import { createYandexPostboxSender } from '../services/yandex-postbox.mjs';

test('Yandex Postbox receives only a plaintext verification code over the fixed API endpoint', async () => {
  let call;
  const send = createYandexPostboxSender({ fromEmail: 'no-reply@example.test', fetchImpl: async (...args) => {
    call = args;
    return { ok: true };
  } });
  await send({ to: 'student@example.test', code: '123456', accessToken: 'synthetic-function-iam-token-0123456789' });
  assert.equal(call[0], 'https://postbox.cloud.yandex.net/v2/email/outbound-emails');
  assert.equal(call[1].headers['x-yacloud-subjecttoken'], 'synthetic-function-iam-token-0123456789');
  const body = JSON.parse(call[1].body);
  assert.deepEqual(body.Destination.ToAddresses, ['student@example.test']);
  assert.match(body.Content.Simple.Body.Text.Data, /123456/);
  assert.equal(Object.hasOwn(body, 'CcAddresses'), false);
  await send({ to: 'student@example.test', code: '654321', accessToken: 'synthetic-function-iam-token-0123456789', purpose: 'step_up' });
  assert.equal(JSON.parse(call[1].body).Content.Simple.Subject.Data, 'Код подтверждения входа FAM');
});

test('Yandex Postbox sender rejects unsafe addresses, codes and non-success responses', async () => {
  assert.equal(createYandexPostboxSender({ fromEmail: 'invalid' }), null);
  const send = createYandexPostboxSender({ fromEmail: 'no-reply@example.test', fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(send({ to: 'student@example.test', code: '12\n345', accessToken: 'synthetic-token' }), /invalid Postbox/);
  await assert.rejects(send({ to: 'student@example.test', code: '123456', accessToken: 'synthetic-function-iam-token-0123456789' }), /Postbox rejected/);
});
