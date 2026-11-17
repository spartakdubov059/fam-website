import test from 'node:test';
import assert from 'node:assert/strict';
import { checkYdbReadiness, createYdbReadinessProbe, getRuntimeReadiness } from '../runtime.mjs';

test('runtime readiness accepts the configured OIDC bearer authentication path', () => {
  assert.deepEqual(getRuntimeReadiness({
    yandexConfigured: false,
    oidcConfigured: true,
    databaseReady: true,
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
    databaseReady: true,
    mediaConfigured: false,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.services.auth, false);
});

test('runtime readiness is false when YDB is unavailable', () => {
  const readiness = getRuntimeReadiness({ yandexConfigured: true, oidcConfigured: false,
    databaseReady: false, mediaConfigured: true });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.services.database, false);
  assert.equal(readiness.services.auth, true);
});

test('YDB readiness executes a minimal query and fails closed on query errors', async () => {
  let queryText = '';
  const sql = async (parts) => { queryText = parts.join('?'); return [[{ ready: 1 }]]; };
  assert.equal(await checkYdbReadiness(sql), true);
  assert.equal(queryText, 'SELECT 1 AS ready;');
  assert.equal(await checkYdbReadiness(async () => { throw new Error('database unavailable'); }), false);
  assert.equal(await checkYdbReadiness(null), false);
});

test('YDB readiness coalesces simultaneous checks and caches results briefly', async () => {
  let time = 10_000;
  let calls = 0;
  let release;
  const sql = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const probe = createYdbReadinessProbe(sql, { cacheMs: 5000, now: () => time });
  const first = probe();
  const concurrent = probe();
  assert.equal(calls, 1);
  release([[{ ready: 1 }]]);
  assert.deepEqual(await Promise.all([first, concurrent]), [true, true]);
  assert.equal(await probe(), true);
  assert.equal(calls, 1);
  time += 5000;
  const refreshed = probe();
  assert.equal(calls, 2);
  release([[{ ready: 1 }]]);
  assert.equal(await refreshed, true);
});
