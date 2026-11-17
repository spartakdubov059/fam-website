import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRuntimeHealth } from '../check-runtime-health.mjs';

test('runtime health check reads only the local readiness route and projects safe status flags', async () => {
  let request;
  const result = await checkRuntimeHealth({ fetchImpl: async (url, options) => {
    request = { url: url.href, options };
    return { ok: true, status: 200, json: async () => ({ ready: true, message: 'private detail', services: { auth: true, database: true, objectStorage: false, secret: 'hidden' } }) };
  } });
  assert.deepEqual(result, { ok: true, ready: true, services: { auth: true, database: true, objectStorage: false } });
  assert.equal(request.url, 'http://127.0.0.1:4178/api/health');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
});

test('runtime health check reports degraded readiness without leaking response text', async () => {
  const result = await checkRuntimeHealth({ fetchImpl: async () => ({ ok: false, status: 503,
    json: async () => ({ ready: false, message: 'credential-value', services: { auth: true, database: false } }) }) });
  assert.deepEqual(result, { ok: false, ready: false, services: { auth: true, database: false, objectStorage: false } });
  assert.doesNotMatch(JSON.stringify(result), /credential-value/);
});

test('runtime health check refuses non-loopback destinations before making a request', async () => {
  let requests = 0;
  await assert.rejects(checkRuntimeHealth({ endpoint: 'https://example.com/api/health', fetchImpl: async () => { requests++; } }), TypeError);
  await assert.rejects(checkRuntimeHealth({ endpoint: 'http://127.0.0.1/api/other', fetchImpl: async () => { requests++; } }), TypeError);
  assert.equal(requests, 0);
});

test('runtime health check permits an explicitly selected IPv6 loopback endpoint', async () => {
  let requestedUrl;
  const result = await checkRuntimeHealth({ endpoint: 'http://[::1]:4179/api/health', fetchImpl: async url => {
    requestedUrl = url.href;
    return { ok: true, json: async () => ({ ready: true }) };
  } });
  assert.equal(requestedUrl, 'http://[::1]:4179/api/health');
  assert.equal(result.ok, true);
});

test('runtime health check turns network and malformed-response failures into a generic unhealthy result', async () => {
  assert.deepEqual(await checkRuntimeHealth({ fetchImpl: async () => { throw new Error('credential-value'); } }),
    { ok: false, ready: false, code: 'health_unavailable' });
  assert.deepEqual(await checkRuntimeHealth({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('credential-value'); } }) }),
    { ok: false, ready: false, code: 'health_unavailable' });
});
