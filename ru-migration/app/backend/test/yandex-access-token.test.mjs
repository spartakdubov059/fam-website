import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYandexIdentityFromAccessToken } from '../auth/yandex-access-token.mjs';

test('operator identity is derived from Yandex user-info and bound to the configured OAuth app', async () => {
  let call;
  const identity = await resolveYandexIdentityFromAccessToken({ accessToken: 'synthetic-temporary-oauth-token', clientId: 'expected-client',
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return { ok: true, json: async () => ({ id: '123456789', client_id: 'expected-client' }) };
    } });
  assert.deepEqual(identity, { issuer: 'https://login.yandex.ru', subject: '123456789' });
  assert.equal(call.url, 'https://login.yandex.ru/info?format=json');
  assert.equal(call.options.headers.authorization, 'OAuth synthetic-temporary-oauth-token');
  assert.equal(new URL(call.url).searchParams.has('oauth_token'), false);
});

test('operator identity rejects another OAuth app, malformed profile data, and rejected tokens', async () => {
  const input = { accessToken: 'synthetic-temporary-oauth-token', clientId: 'expected-client' };
  await assert.rejects(resolveYandexIdentityFromAccessToken({ ...input,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: '123456789', client_id: 'other-client' }) }) }), /did not match/);
  await assert.rejects(resolveYandexIdentityFromAccessToken({ ...input,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'not-numeric', client_id: 'expected-client' }) }) }), /did not match/);
  await assert.rejects(resolveYandexIdentityFromAccessToken({ ...input,
    fetchImpl: async () => ({ ok: false }) }), /rejected/);
  await assert.rejects(resolveYandexIdentityFromAccessToken({ ...input, accessToken: 'short' }), /invalid Yandex access token/);
});
