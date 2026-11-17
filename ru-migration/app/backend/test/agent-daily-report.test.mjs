import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDailyReport } from '../services/agent-daily-report.mjs';

test('global daily report stores only aggregate operational counts and is date-stable', async () => {
  const writes = [];
  const metrics = {
    listings: { active: 3, new_24h: 1 }, safety: { unreviewed: 2 },
    account_requests: { deletion_pending: 1, active_suspensions: 0 },
    ideas: { pending: 4, approved: 5, rejected: 6 },
  };
  const refresh = createAgentDailyReport({
    repository: {
      getGlobalAgentDailyMetrics: async () => metrics,
      saveGlobalAgentDailyReport: async report => writes.push(report),
    },
    now: () => new Date('2026-11-14T06:00:00Z'),
  });
  assert.deepEqual(await refresh(), { refreshed: true, date: '2026-11-14' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].date, '2026-11-14');
  assert.equal(writes[0].metrics, metrics);
  assert.match(writes[0].summary, /активных объявлений 3/);
  assert.doesNotMatch(JSON.stringify(writes[0]), /student|user_id|message|email|subject/i);
});
