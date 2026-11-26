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
  evaluateLegalConsultation,
} from './fam-agent-team-governance.mjs';

test('RU team preserves the original governance roles and no recruitment authority', () => {
  const keys = RU_AGENT_TEAM.map(role => role.key);
  for (const key of ['developer', 'inspector', 'qa', 'arbiter', 'integrator', 'recruiter']) assert.ok(keys.includes(key));
  for (const key of ['coordinator', 'security_reviewer', 'tester', 'analyst']) assert.ok(keys.includes(key));
  assert.equal(keys.includes('qwen'), false);
  assert.equal(keys.includes('legal_advisor'), true);
  assert.equal(RU_AGENT_TEAM.filter(role => role.allows_model).length, 1);
  assert.equal(RU_AGENT_TEAM.find(role => role.key === 'recruiter').permissions.includes('propose_human_review'), true);
  const approvedNames = Object.fromEntries(RU_AGENT_TEAM.map(role => [role.key, role.display_name]));
  assert.deepEqual({
    coordinator: approvedNames.coordinator,
    security_reviewer: approvedNames.security_reviewer,
    legal_advisor: approvedNames.legal_advisor,
    developer: approvedNames.developer,
    tester: approvedNames.tester,
    integrator: approvedNames.integrator,
    analyst: approvedNames.analyst,
    inspector: approvedNames.inspector,
  }, {
    coordinator: 'Босс', security_reviewer: 'Проверяющий', legal_advisor: 'Юрист',
    developer: 'Разработчик (Qwen)', tester: 'Испытатель', integrator: 'Связной',
    analyst: 'Советник', inspector: 'Надзиратель',
  });
  const lawyer = RU_AGENT_TEAM.find(role => role.key === 'legal_advisor');
  assert.equal(lawyer.allows_model, false);
  assert.equal(lawyer.permissions.some(permission => /approve|sign|consent|release|deploy|pii/i.test(permission)), false);
  assert.equal(createAgentTeamLifecycleTask({ role: 'legal_advisor', task: 'Prepare code patch' }).ok, false);
});

test('legal consultation is revision and scope bound, advisory only, and cannot authorize release', () => {
  const revision = 'a'.repeat(64);
  const checkedAt = new Date().toISOString();
  const guidance = {
    role: 'legal_advisor', scope: 'FAM_RU', revision_sha256: revision,
    advice_status: 'advisory_only', human_review: 'pending_human_review',
    requirement_codes: ['data_minimization'], alternative_codes: ['synthetic_only', 'defer_live_transfer'],
    source_checks: [{ url: 'https://publication.pravo.gov.ru/', checked_at: checkedAt, source_digest: 'b'.repeat(64) }],
    decision_digest: 'c'.repeat(64), synthetic_only: true,
  };
  const result = evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: revision,
    impact: 'possible', classifier: 'arbiter', guidance });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'advisory_only');
  assert.equal(result.human_review, 'pending_human_review');
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.permission_escalation, false);
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: revision,
    impact: 'unknown', classifier: 'arbiter', guidance: null }).code, 'LEGAL_CONSULTATION_REQUIRED');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_CURRENT', revision_sha256: revision,
    impact: 'possible', classifier: 'arbiter', guidance }).code, 'LEGAL_CONSULTATION_REQUIRED');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: 'd'.repeat(64),
    impact: 'possible', classifier: 'arbiter', guidance }).code, 'LEGAL_CONSULTATION_REQUIRED');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: revision,
    impact: 'none', classifier: 'developer', guidance: null }).code, 'INVALID_LEGAL_CONSULTATION_SCOPE');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_CURRENT', revision_sha256: revision,
    impact: 'none', classifier: 'arbiter', guidance: null }).status, 'not_required');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: revision,
    impact: 'possible', classifier: 'arbiter', guidance: { ...guidance, advice_status: 'approved' } }).code, 'LEGAL_CONSULTATION_REQUIRED');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: revision,
    impact: 'possible', classifier: 'arbiter', guidance: { ...guidance, source_checks: [{ ...guidance.source_checks[0], url: 'https://example.com/law' }] } }).code, 'LEGAL_SOURCE_NOT_ALLOWLISTED');
  assert.equal(evaluateLegalConsultation({ scope: 'FAM_RU', revision_sha256: revision,
    impact: 'possible', classifier: 'arbiter', guidance: { ...guidance, source_checks: [{ ...guidance.source_checks[0], personal_data: true }] } }).code, 'LEGAL_SOURCE_CHECK_INVALID');
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
