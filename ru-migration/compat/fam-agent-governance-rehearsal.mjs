import {
  findAgentDisputes,
  buildAgentIntegrationPlan,
  inspectInfrastructureSignals,
  proposeHumanRecruitment,
  validateInspectorSignal,
} from './fam-agent-team-governance.mjs';

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function runIsolatedAgentGovernanceRehearsal(input) {
  const fail = code => ({ ok: false, code, production_access: false, live_cutover_authorized: false });
  if (!exactKeys(input, ['pulls', 'queue', 'warnings', 'developerPatch', 'qaResult'])) return fail('INVALID_REHEARSAL_INPUT');
  if (!Array.isArray(input.pulls) || !input.pulls.length || input.pulls.length > 25
      || !Array.isArray(input.warnings)
      || typeof input.queue !== 'object' || input.queue === null
      || typeof input.developerPatch !== 'object' || input.developerPatch === null
      || typeof input.qaResult !== 'object' || input.qaResult === null) return fail('INVALID_REHEARSAL_INPUT');

  const disputed = findAgentDisputes(input.pulls);
  const plan = buildAgentIntegrationPlan({ pulls: input.pulls, disputes: disputed.disputes });
  const signals = inspectInfrastructureSignals({ queue: input.queue, warnings: input.warnings });
  const recruitment = proposeHumanRecruitment({
    disputes: disputed.disputes,
    signals,
  });

  const inspectorSignal = signals[0] ? {
    signal_code: signals[0].code,
    event_id: `synthetic:governance:${signals[0].code}`,
    occurrences: signals[0].count,
  } : null;
  if (inspectorSignal && !validateInspectorSignal(inspectorSignal).ok) return fail('INVALID_INSPECTOR_SIGNAL');

  const patch = input.developerPatch;
  if (!exactKeys(patch, ['approved_scope', 'has_patch', 'synthetic_only'])
      || !Array.isArray(patch.approved_scope)
      || patch.approved_scope.length > 20
      || typeof patch.has_patch !== 'boolean'
      || patch.synthetic_only !== true) return fail('INVALID_DEVELOPER_RESULT');
  if (patch.approved_scope.some(path =>
    typeof path !== 'string'
    || (!path.startsWith('ru-migration/') && !path.startsWith('docs/') && !path.startsWith('tests/')))) {
    return fail('DEVELOPER_SCOPE_VIOLATION');
  }

  const qa = input.qaResult;
  if (!exactKeys(qa, ['passed', 'tests_run', 'production_access'])
      || typeof qa.passed !== 'boolean'
      || !Number.isSafeInteger(qa.tests_run)
      || qa.tests_run < 0
      || qa.production_access !== false) return fail('INVALID_QA_RESULT');

  const stages = [
    { role: 'inspector', status: inspectorSignal ? 'signal_ready' : 'no_signal' },
    { role: 'developer', status: patch.has_patch ? 'patch_ready' : 'no_patch' },
    { role: 'qa', status: qa.passed ? 'passed' : 'failed' },
    { role: 'arbiter', status: disputed.disputes.length ? 'conflicts_detected' : 'no_conflicts' },
    { role: 'integrator', status: plan.groups.length ? 'review_plan_ready' : 'no_integration_needed' },
    { role: 'recruiter', status: recruitment.length ? 'human_review_proposed' : 'no_recruitment_proposed' },
  ];

  if (patch.has_patch && (!qa.passed || qa.tests_run === 0)) return fail('QA_GATE_NOT_PASSED');
  return Object.freeze({
    ok: true,
    code: 'ISOLATED_AGENT_GOVERNANCE_REHEARSAL_PASS',
    stages: Object.freeze(stages.map(stage => Object.freeze(stage))),
    disputes: Object.freeze(disputed),
    integrationPlan: Object.freeze(plan),
    inspectorSignal: inspectorSignal ? Object.freeze(inspectorSignal) : null,
    recruitment: Object.freeze(recruitment),
    production_access: false,
    live_cutover_authorized: false,
  });
}
