import test from 'node:test';
import assert from 'node:assert/strict';
import { createYandexIamMetadataTokenProvider } from '../services/yandex-iam-metadata.mjs';

test('VM metadata token provider requests IAM tokens safely and reuses them until refresh', async () => {
  let now = 1_000_000;
  let calls = 0;
  const getToken = createYandexIamMetadataTokenProvider({ now: () => now, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token');
    assert.equal(options.headers['metadata-flavor'], 'Google');
    return { ok: true, json: async () => ({ access_token: 'synthetic-yandex-iam-token-0123456789', expires_in: 3600 }) };
  } });
  assert.equal(await getToken(), 'synthetic-yandex-iam-token-0123456789');
  assert.equal(await getToken(), 'synthetic-yandex-iam-token-0123456789');
  assert.equal(calls, 1);
  now += 3_541_000;
  await getToken();
  assert.equal(calls, 2);
});

test('VM metadata token provider rejects invalid endpoints, responses, and HTTP errors', async () => {
  assert.throws(() => createYandexIamMetadataTokenProvider({ endpoint: 'http://example.test/token' }), /configuration/);
  const malformed = createYandexIamMetadataTokenProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'short', expires_in: 3600 }) }) });
  await assert.rejects(malformed(), /invalid IAM token/);
  const unavailable = createYandexIamMetadataTokenProvider({ fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(unavailable(), /rejected IAM token/);
});
