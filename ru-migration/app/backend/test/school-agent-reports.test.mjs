import test from 'node:test';
import assert from 'node:assert/strict';
import { createSchoolAgentReports } from '../services/school-agent-reports.mjs';

test('school analyst creates dated aggregate reports and deterministic non-LLM suggestions only for nonzero signals', async () => {
  const saved = []; const ideas = [];
  const refresh = createSchoolAgentReports({ schools: [{ id: 'school-a' }, { id: 'school-b' }, { id: 'school-empty' }], now: () => new Date('2026-11-14T06:00:00Z'), repository: {
    getSchoolAgentMetrics: async schoolId => ({ listings: { active: schoolId === 'school-empty' ? 0 : 3, new_24h: 1 }, safety: { unreviewed: schoolId === 'school-a' ? 2 : 0, high_unreviewed: schoolId === 'school-a' ? 1 : 0 },
      account_requests: { deletion_pending: 0, active_suspensions: 1 }, ideas: { awaiting_council: schoolId === 'school-a' ? 1 : 0 } }),
    countPendingSchoolAgentIdeas: async schoolId => ideas.filter(idea => idea.schoolId === schoolId).length,
    saveSchoolAgentReport: async report => saved.push(report), createSchoolAgentIdea: async idea => ideas.push(idea),
  } });
  assert.deepEqual(await refresh(), { refreshed: 3 });
  assert.equal(saved.length, 3); assert.equal(saved[0].date, '2026-11-14');
  assert.equal(ideas.length, 3); assert.deepEqual(ideas.map(item => item.rule.key), ['safety_review', 'council_ideas_review', 'board_empty']);
  assert.equal(ideas[0].count, 2); assert.match(ideas[0].id, /^[a-f0-9]{64}$/);
  assert.equal(ideas.some(item => item.rule.key === 'deletion_requests_review'), false);
  assert.equal(ideas[2].count, 0);
  assert.equal(saved[0].metrics.safety.high_unreviewed, 1);
  assert.equal(saved[0].metrics.agent_proposals.pending, 2);
  assert.match(saved[0].summary, /высокого уровня 1/);
  assert.match(saved[0].summary, /аналитических правил ждут решения 2/);
});
