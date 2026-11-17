import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeReadiness } from '../runtime.mjs';

test('runtime readiness accepts the configured OIDC bearer authentication path', () => {
  assert.deepEqual(getRuntimeReadiness({
    yandexConfigured: false,
    oidcConfigured: true,
    mediaConfigured: false,
  }), {
    mode: 'isolated-copy',
    ready: true,
    services: { auth: true, database: true, objectStorage: false },
    message: 'Russian backend is configured with OIDC bearer authentication; optional media storage is reported separately.',
  });
});

test('runtime readiness remains false when neither supported auth mode is configured', () => {
  const readiness = getRuntimeReadiness({
    yandexConfigured: false,
    oidcConfigured: false,
    mediaConfigured: false,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.services.auth, false);
});
