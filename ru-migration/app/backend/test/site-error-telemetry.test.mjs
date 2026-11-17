import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSiteErrorTelemetry } from '../services/site-error-telemetry.mjs';
import { createListingsApi } from '../services/listings-api.mjs';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';

const request = (body, { method = 'POST', origin = 'https://fam.example.ru', host = 'fam.example.ru' } = {}) => {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = { origin, host };
  return req;
};

test('site error telemetry accepts only fixed anonymous codes and discards extra fields', async () => {
  const records = [];
  const report = createSiteErrorTelemetry({
    repository: { recordSiteError: async row => records.push(row) },
    now: () => new Date('2026-11-15T12:34:56Z'),
  });
  assert.deepEqual(await report(request({ event_code: 'js_runtime', page_area: 'other', message: 'private text', user_id: 'student-1' })),
    { status: 202, body: { ok: true } });
  assert.deepEqual(records, [{ eventCode: 'js_runtime', pageArea: 'other', occurredAt: new Date('2026-11-15T12:34:56Z') }]);
  assert.deepEqual(await report(request({ event_code: 'arbitrary', page_area: 'other' })),
    { status: 400, body: { ok: false, error: 'invalid_event' } });
  assert.equal(records.length, 1);
});

test('site error API remains anonymous while passing only enumerated data to the repository', async () => {
  const records = [];
  const api = createListingsApi({
    authenticate: async () => { throw new Error('telemetry must not require sign-in'); },
    resolveActor: async () => null,
    repository: { recordSiteError: async row => records.push(row) },
  });
  const req = request({ event_code: 'listings_load_failed', page_area: 'listings', message: 'discard me' });
  req.url = '/api/v1/site-errors';
  assert.deepEqual(await api(req), { status: 202, body: { ok: true } });
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ['eventCode', 'occurredAt', 'pageArea']);
});

test('site error telemetry caps database writes per process and minute', async () => {
  const records = [];
  let clock = new Date('2026-11-15T12:34:10Z');
  const report = createSiteErrorTelemetry({
    repository: { recordSiteError: async row => records.push(row) },
    now: () => clock,
    maxPerMinute: 2,
  });
  const valid = { event_code: 'js_runtime', page_area: 'other' };
  const withoutOrigin = request(valid);
  delete withoutOrigin.headers.origin;
  assert.equal((await report(withoutOrigin)).status, 202);
  assert.equal((await report(request(valid))).status, 202);
  assert.deepEqual(await report(request(valid)),
    { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.equal(records.length, 2);
  clock = new Date('2026-11-15T12:35:00Z');
  assert.equal((await report(request(valid))).status, 202);
  assert.equal(records.length, 3);
});

test('site error telemetry rejects cross-origin, malformed, oversized and unavailable requests', async () => {
  const report = createSiteErrorTelemetry({ repository: { recordSiteError: async () => {} } });
  assert.equal((await report(request({}, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await report(request('{'))).status, 400);
  assert.equal((await report(request('x'.repeat(1025)))).status, 413);
  assert.equal((await report(request({ event_code: 'js_runtime', page_area: 'other' }, { method: 'GET' }))).status, 405);
  const unavailable = createSiteErrorTelemetry({ repository: { recordSiteError: async () => { throw new Error('database failure'); } } });
  assert.equal((await unavailable(request({ event_code: 'js_runtime', page_area: 'other' }))).status, 503);
});

test('YDB site error counter is hourly, bounded, and stores only allowlisted fields', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT event_count')) return [[{ event_count: 999 }]];
    return [[]];
  };
  const sql = Object.assign(() => Promise.resolve([[]]), { begin: work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  assert.equal(await repo.recordSiteError({ eventCode: 'js_runtime', pageArea: 'other', occurredAt: new Date('2026-11-15T12:34:00Z') }), 1000);
  const write = calls.find(call => call.text.includes('UPSERT INTO fam_site_error_counts'));
  assert.ok(write);
  assert.ok(write.values.includes('js_runtime') && write.values.includes('other'));
  assert.ok(write.values.includes('2026-11-15T12:00:00.000Z'));
  assert.equal(write.values.includes('private text'), false);
  assert.match(write.text, /CAST\(\? AS Uint32\)/);
});
