import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestratorDailyDigest } from '../services/orchestrator-daily-digest.mjs';

const date = new Date('2026-11-18T06:05:00.000Z');
const metrics = { active_listings: 8, new_listings_24h: 2, pending_ideas: 1, queued_tasks: 0,
  completed_tasks_24h: 3, blocked_tasks_24h: 0, failed_tasks_24h: 0 };

test('daily digest is idempotently queued and stores only the allowlisted aggregate summary', async () => {
  const calls = [];
  const run = createOrchestratorDailyDigest({ now: () => date, repository: {
    enqueueAgentDailyDigestTask: async reportDate => { calls.push(['enqueue', reportDate]); return { created: true, status: 'queued' }; },
    claimAgentDailyDigestTask: async workerId => { calls.push(['claim', workerId]); return { report_date: '2026-11-18', claim_token: 'claim-token' }; },
    getAgentDailyDigestMetrics: async () => metrics,
    completeAgentDailyDigestTask: async task => { calls.push(['complete', task]); return true; },
    retryAgentDailyDigestTask: async task => { calls.push(['retry', task]); return true; },
  } });

  const result = await run();
  assert.deepEqual(result, { processed: true, created: true, date: '2026-11-18', metrics });
  assert.deepEqual(calls.slice(0, 2), [['enqueue', '2026-11-18'], ['claim', 'fam-ru-orchestrator-digest-v1']]);
  const completed = calls.find(call => call[0] === 'complete')[1];
  assert.equal(completed.reportDate, '2026-11-18');
  assert.deepEqual(completed.metrics, metrics);
  assert.match(completed.summary, /только агрегированные рабочие показатели/);
  assert.doesNotMatch(completed.summary, /student|student_id|message|телефон|почта/i);
  assert.equal(calls.some(call => call[0] === 'retry'), false);
});

test('daily digest reports no work when the durable queue has no eligible task', async () => {
  let reads = 0;
  const run = createOrchestratorDailyDigest({ now: () => date, repository: {
    enqueueAgentDailyDigestTask: async () => ({ created: false, status: 'completed' }),
    claimAgentDailyDigestTask: async () => null,
    getAgentDailyDigestMetrics: async () => { reads++; return metrics; },
  } });
  assert.deepEqual(await run(), { processed: false, created: false, date: '2026-11-18' });
  assert.equal(reads, 0);
});

test('daily digest retries invalid metrics using a fixed internal error code', async () => {
  const retries = [];
  const run = createOrchestratorDailyDigest({ now: () => date, repository: {
    enqueueAgentDailyDigestTask: async () => ({ created: false }),
    claimAgentDailyDigestTask: async () => ({ report_date: '2026-11-18', claim_token: 'claim-token' }),
    getAgentDailyDigestMetrics: async () => ({ ...metrics, active_listings: -1 }),
    retryAgentDailyDigestTask: async task => { retries.push(task); return true; },
  } });
  await assert.rejects(run(), /invalid_metrics/);
  assert.deepEqual(retries, [{ reportDate: '2026-11-18', claimToken: 'claim-token', errorCode: 'invalid_metrics' }]);
});
