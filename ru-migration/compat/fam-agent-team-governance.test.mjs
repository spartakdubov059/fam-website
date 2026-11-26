import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RU_AGENT_TEAM,
  findAgentDisputes,
  buildAgentIntegrationPlan,
  inspectInfrastructureSignals,
  proposeHumanRecruitment,
  validateInspectorSignal,
  createAgentTeamLifecycleTask,
} from './fam-agent-team-governance.mjs';

test('RU team preserves the original governance roles and no recruitment authority', () => {
  const keys = RU_AGENT_TEAM.map(role => role.key);
  for (const key of ['inspector', 'qwen', 'qa', 'arbiter', 'integrator', 'recruiter']) assert.ok(keys.includes(key));
  assert.equal(RU_AGENT_TEAM.filter(role => role.allows_model).length, 2);
  assert.equal(RU_AGENT_TEAM.find(role => role.key === 'recruiter').permissions.includes('propose_human_review'), true);
});

test('arbiter detects only overlapping code files and integrator creates review clusters', () => {
  const result = findAgentDisputes([
    { number: 3, files: ['ru-migration/app/backend/server.mjs', 'docs/no-op.md'] },
    { number: 7, files: ['ru-migration/app/backend/server.mjs', 'docs/no-op.md'] },
  ]);
  assert.equal(result.disputes.length, 1);
  assert.equal(result.disputes[0].highRisk, true);
  const plan = buildAgentIntegrationPlan({ pulls: [
    { number: 3, draft: false },
    { number: 7, draft: true },
  ], disputes: result.disputes });
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0].reviewSequence, [3, 7]);
  assert.match(plan.groups[0].recommendation, /security review/);
});

test('inspector maps only bounded aggregate infrastructure signals', () => {
  const signals = inspectInfrastructureSignals({
    queue: { failed_last_24h: 4, expired_leases: 1 },
    warnings: [
      { code: 'repeated_failures', severity: 'high', count: 3 },
      { code: 'stuck_runs', severity: 'low', count: 9 },
    ],
  });
  assert.deepEqual(signals.map(signal => signal.code).sort(),
    ['qwen_repeated_failure', 'worker_expired_lease', 'worker_queue_failure']);
  assert.equal(validateInspectorSignal({
    signal_code: 'worker_queue_failure',
    event_id: 'ci:ru:worker',
    occurrences: 3,
  }).ok, true);
  assert.equal(validateInspectorSignal({
    signal_code: 'unknown',
    event_id: 'ci:ru:worker',
    occurrences: 3,
  }).ok, false);
});

test('recruiter only proposes human-reviewed roles and team tasks enforce approval', () => {
  const proposals = proposeHumanRecruitment({
    disputes: Array.from({ length: 3 }, (_, index) => ({ prs: [index + 1, index + 2] })),
    signals: [{ code: 'qwen_repeated_failure', severity: 'high', count: 3 }],
  });
  assert.equal(proposals.length, 2);
  assert.equal(createAgentTeamLifecycleTask({
    role: 'developer',
    task: 'Подготовить минимальный безопасный patch',
    fileAllowlist: ['ru-migration/app/backend/server.mjs'],
  }).ok, true);
  assert.equal(createAgentTeamLifecycleTask({
    role: 'developer',
    task: 'Выполнить необратимое изменение',
    requiresApproval: false,
  }).ok, false);
});
