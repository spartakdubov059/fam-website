import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteErrorDigest, getSiteErrorDigestSlot } from '../services/site-error-digest.mjs';

const now = () => new Date('2026-11-18T06:30:00.000Z');
const metrics = { total_events_24h: 14, events_last_hour: 4,
  events: [{ event_code: 'database_request_failed', page_area: 'database', occurrences: 9 }] };

test('site error digest is slot-idempotent and saves only the allowlisted aggregate summary', async () => {
  const calls = [];
  let claimCount = 0;
  const run = createSiteErrorDigest({ now, repository: {
    enqueueSiteErrorDigestTask: async slot => { calls.push(['enqueue', slot]); return { created: true, status: 'queued' }; },
    claimSiteErrorDigestTask: async worker => {
      calls.push(['claim', worker]);
      claimCount++;
      return claimCount === 1 ? { digest_slot: '2026-11-18T06:30', claim_token: 'synthetic-claim' } : null;
    },
    getSiteErrorDigestMetrics: async () => metrics,
    completeSiteErrorDigestTask: async value => { calls.push(['complete', value]); return true; },
    retrySiteErrorDigestTask: async value => { calls.push(['retry', value]); return true; },
  } });
  assert.deepEqual(await run(), { processed: true, processed_count: 1, created: true, slot: '2026-11-18T06:30',
    processed_slots: ['2026-11-18T06:30'], metrics });
  assert.deepEqual(calls.slice(0, 2), [['enqueue', '2026-11-18T06:30'], ['claim', 'fam-ru-site-error-digest-v1']]);
  const saved = calls.find(call => call[0] === 'complete')[1];
  assert.equal(saved.digestSlot, '2026-11-18T06:30');
  assert.deepEqual(saved.metrics, metrics);
  assert.match(saved.summary, /только агрегированные коды ошибок/);
  assert.doesNotMatch(saved.summary, /student|user_id|https?:|stack|телефон|почта/i);
  assert.equal(calls.some(call => call[0] === 'retry'), false);
});

test('site error digest skips metrics when the current slot is already completed', async () => {
  let reads = 0;
  const run = createSiteErrorDigest({ now, repository: {
    enqueueSiteErrorDigestTask: async () => ({ created: false, status: 'completed' }),
    claimSiteErrorDigestTask: async () => null,
    getSiteErrorDigestMetrics: async () => { reads++; return metrics; },
  } });
  assert.deepEqual(await run(), { processed: false, processed_count: 0, created: false, slot: '2026-11-18T06:30', processed_slots: [], metrics: null });
  assert.equal(reads, 0);
});

test('site error digest drains only a bounded number of overdue hourly tasks', async () => {
  let claim = 0;
  let completed = 0;
  const slots = ['2026-11-18T02:30', '2026-11-18T03:30', '2026-11-18T04:30', '2026-11-18T05:30', '2026-11-18T06:30'];
  const run = createSiteErrorDigest({ now, repository: {
    enqueueSiteErrorDigestTask: async () => ({ created: true }),
    claimSiteErrorDigestTask: async () => {
      claim++;
      return claim <= slots.length ? { digest_slot: slots[claim - 1], claim_token: `claim-${claim}` } : null;
    },
    getSiteErrorDigestMetrics: async () => metrics,
    completeSiteErrorDigestTask: async () => { completed++; return true; },
  } });
  const result = await run();
  assert.equal(result.processed_count, 4);
  assert.equal(completed, 4);
  assert.equal(claim, 4, 'one invocation never processes unbounded backlog');
});

test('site error digest maps instants to the latest due hourly slot and rejects quarter-hour claims', async () => {
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:29:59.999Z')), '2026-11-18T05:30');
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:30:00.000Z')), '2026-11-18T06:30');
  assert.equal(getSiteErrorDigestSlot(new Date('2026-11-18T06:59:59.999Z')), '2026-11-18T06:30');
  const run = createSiteErrorDigest({ now, repository: {
    enqueueSiteErrorDigestTask: async () => ({ created: false }),
    claimSiteErrorDigestTask: async () => ({ digest_slot: '2026-11-18T06:15', claim_token: 'synthetic-claim' }),
    retrySiteErrorDigestTask: async () => true,
  } });
  await assert.rejects(run(), /invalid site error digest claim/);
});

test('site error digest retries invalid aggregate results with a fixed error code', async () => {
  const retries = [];
  const run = createSiteErrorDigest({ now, repository: {
    enqueueSiteErrorDigestTask: async () => ({ created: false }),
    claimSiteErrorDigestTask: async () => ({ digest_slot: '2026-11-18T06:30', claim_token: 'synthetic-claim' }),
    getSiteErrorDigestMetrics: async () => ({ ...metrics, events: [{ ...metrics.events[0], page_area: 'https://secret.invalid' }] }),
    retrySiteErrorDigestTask: async value => { retries.push(value); return true; },
  } });
  await assert.rejects(run(), /invalid_metrics/);
  assert.deepEqual(retries, [{ digestSlot: '2026-11-18T06:30', claimToken: 'synthetic-claim', errorCode: 'invalid_metrics' }]);
});
