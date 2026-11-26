import { isSafeRehearsalScope } from './fam-agent-execution-evidence.mjs';
import {
  findAgentDisputes,
  buildAgentIntegrationPlan,
  inspectInfrastructureSignals,
  proposeHumanRecruitment,
  validateInspectorSignal,
  evaluateLegalConsultation,
} from './fam-agent-team-governance.mjs';

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function runIsolatedAgentGovernanceRehearsal(input) {
  const fail = code => ({ ok: false, code, production_access: false, live_cutover_authorized: false });
  if (!exactKeys(input, ['pulls', 'queue', 'warnings', 'legalConsultation', 'developerPatch', 'qaResult'])) return fail('INVALID_REHEARSAL_INPUT');
  if (!Array.isArray(input.pulls) || !input.pulls.length || input.pulls.length > 25
      || !Array.isArray(input.warnings)
      || typeof input.queue !== 'object' || input.queue === null
      || typeof input.legalConsultation !== 'object' || input.legalConsultation === null
      || typeof input.developerPatch !== 'object' || input.developerPatch === null
      || typeof input.qaResult !== 'object' || input.qaResult === null) return fail('INVALID_REHEARSAL_INPUT');

  // The legal scope check precedes developer result processing. The rehearsal
  // accepts only synthetic advisory receipts and never grants release authority.
  const legalConsultation = evaluateLegalConsultation(input.legalConsultation);
  if (!legalConsultation.ok) return fail(legalConsultation.code);
  if (legalConsultation.scope !== 'FAM_RU') return fail('LEGAL_SCOPE_MISMATCH');

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
  if (!exactKeys(patch, ['approved_scope', 'has_patch', 'synthetic_only', 'patch_digest', 'revision_sha256', 'production_access'])
      || !Array.isArray(patch.approved_scope)
      || patch.approved_scope.length > 20
      || typeof patch.has_patch !== 'boolean'
      || patch.synthetic_only !== true
      || patch.production_access !== false
      || typeof patch.patch_digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(patch.patch_digest)
      || typeof patch.revision_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(patch.revision_sha256)) return fail('INVALID_DEVELOPER_RESULT');
  if (patch.approved_scope.some(path=>!isSafeRehearsalScope(path)) || new Set(patch.approved_scope).size!==patch.approved_scope.length || (patch.has_patch&&patch.approved_scope.length===0)) {
    return fail('DEVELOPER_SCOPE_VIOLATION');
  }

  const qa = input.qaResult;
  if (!exactKeys(qa, ['passed', 'tests_run', 'production_access', 'test_digest', 'output_sha256', 'observed_at', 'revision_sha256', 'subject_sha256', 'patch_digest'])
      || typeof qa.passed !== 'boolean'
      || !Number.isSafeInteger(qa.tests_run)
      || qa.tests_run < 0
      || qa.production_access !== false
      || typeof qa.test_digest !== 'string' || !/^[a-f0-9]{64}$/.test(qa.test_digest)
      || typeof qa.output_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(qa.output_sha256)
      || typeof qa.observed_at !== 'string'
      || typeof qa.revision_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(qa.revision_sha256)
      || typeof qa.subject_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(qa.subject_sha256)
      || typeof qa.patch_digest !== 'string' || !/^[a-f0-9]{64}$/.test(qa.patch_digest)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(qa.observed_at)
      || !Number.isFinite(Date.parse(qa.observed_at))) return fail('INVALID_QA_RESULT');
  if (qa.patch_digest !== patch.patch_digest) return fail('QA_PATCH_MISMATCH');
  if (qa.revision_sha256 !== patch.revision_sha256) return fail('QA_REVISION_MISMATCH');

  const stages = [
    { role: 'inspector', status: inspectorSignal ? 'signal_ready' : 'no_signal' },
    { role: 'legal_advisor', status: legalConsultation.status },
    { role: 'developer', status: patch.has_patch ? 'patch_ready' : 'no_patch' },
    { role: 'qa', status: qa.passed ? 'passed' : 'failed' },
    { role: 'arbiter', status: disputed.disputes.length ? 'conflicts_detected' : 'no_conflicts' },
    { role: 'integrator', status: plan.groups.length ? 'review_plan_ready' : 'no_integration_needed' },
    { role: 'recruiter', status: recruitment.length ? 'human_review_proposed' : 'no_recruitment_proposed' },
  ];

  if (!qa.passed || qa.tests_run === 0) return fail('QA_GATE_NOT_PASSED');
  return Object.freeze({
    ok: true,
    code: 'ISOLATED_AGENT_GOVERNANCE_REHEARSAL_PASS',
    stages: Object.freeze(stages.map(stage => Object.freeze(stage))),
    disputes: Object.freeze(disputed),
    integrationPlan: Object.freeze(plan),
    legalConsultation: Object.freeze(legalConsultation),
    inspectorSignal: inspectorSignal ? Object.freeze(inspectorSignal) : null,
    recruitment: Object.freeze(recruitment),
    production_access: false,
    live_cutover_authorized: false,
  });
}
