import test from 'node:test';
import assert from 'node:assert/strict';
import { runIsolatedAgentGovernanceRehearsal } from './fam-agent-governance-rehearsal.mjs';
import { evaluateLegalConsultation } from './fam-agent-team-governance.mjs';

const sha = 'a'.repeat(64);
const observed = '2026-11-27T00:00:00.000Z';
const qaEvidence = passed => ({
  passed,
  tests_run: 788,
  production_access: false,
  test_digest: sha,
  output_sha256: sha,
  observed_at: observed,
  revision_sha256: sha,
  subject_sha256: sha,
  patch_digest: sha,
});
const patchEvidence = scope => ({
  approved_scope: scope,
  has_patch: true,
  synthetic_only: true,
  patch_digest: sha,
  revision_sha256: sha,
  production_access: false,
});
const legalEvidence = (scope = 'FAM_RU', revision = sha, impact = 'possible') => ({
  scope, revision_sha256: revision, impact, classifier: 'arbiter',
  guidance: impact === 'none' ? null : {
    role: 'legal_advisor', scope, revision_sha256: revision,
    advice_status: 'advisory_only', human_review: 'pending_human_review',
    requirement_codes: ['minimize_data'], alternative_codes: ['synthetic_only', 'defer_live_transfer'],
    source_checks: [{ url: 'https://publication.pravo.gov.ru/', checked_at: new Date().toISOString(), source_digest: sha }],
    decision_digest: sha, synthetic_only: true,
  },
});

test('isolated full governance pipeline connects inspector developer QA arbiter integrator recruiter', () => {
  const result = runIsolatedAgentGovernanceRehearsal({
    pulls: [
      { number: 167, draft: false, files: ['ru-migration/app/backend/server.mjs', 'ru-migration/compat/integration-ydb.mjs'] },
      { number: 168, draft: true, files: ['ru-migration/app/backend/server.mjs', 'docs/test.md'] },
    ],
    queue: { failed_last_24h: 4, expired_leases: 1 },
    warnings: [{ code: 'repeated_failures', severity: 'high', count: 3 }],
    legalConsultation: legalEvidence(),
    developerPatch: patchEvidence(['ru-migration/app/backend/server.mjs']),
    qaResult: qaEvidence(true),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stages.map(stage => stage.role),
    ['inspector', 'legal_advisor', 'developer', 'qa', 'arbiter', 'integrator', 'recruiter']);
  assert.equal(result.stages[1].status, 'advisory_only');
  assert.equal(result.legalConsultation.human_review, 'pending_human_review');
  assert.equal(result.production_access, false);
  assert.equal(result.live_cutover_authorized, false);
  assert.equal(result.inspectorSignal.occurrences, 4);
  assert.equal(result.integrationPlan.groups.length, 1);
  assert.equal(result.recruitment.length, 1);
});

test('isolated pipeline stops patch release when QA or scope is invalid', () => {
  const base = {
    pulls: [{ number: 167, draft: false, files: ['ru-migration/app/backend/server.mjs'] }],
    queue: { failed_last_24h: 0, expired_leases: 0 },
    warnings: [],
    legalConsultation: legalEvidence(),
    developerPatch: patchEvidence(['ru-migration/app/backend/server.mjs']),
    qaResult: qaEvidence(true),
  };
  const failedQa = { ...base, qaResult: qaEvidence(false) };
  assert.equal(runIsolatedAgentGovernanceRehearsal(failedQa).code, 'QA_GATE_NOT_PASSED');
  const scope = { ...base, developerPatch: patchEvidence(['supabase/functions/moderate/index.ts']) };
  assert.equal(runIsolatedAgentGovernanceRehearsal(scope).code, 'DEVELOPER_SCOPE_VIOLATION');
});


test('governance cannot pass on failed or empty QA even when there is no patch',()=>{
 const base={pulls:[{number:167,draft:false,files:[]}],queue:{failed_last_24h:0,expired_leases:0},warnings:[],legalConsultation:legalEvidence(),developerPatch:{...patchEvidence(['ru-migration/app/backend/server.mjs']),has_patch:false},qaResult:qaEvidence(true)};
 assert.equal(runIsolatedAgentGovernanceRehearsal({...base,qaResult:qaEvidence(false)}).code,'QA_GATE_NOT_PASSED');
 assert.equal(runIsolatedAgentGovernanceRehearsal({...base,qaResult:{...qaEvidence(true),tests_run:0}}).code,'QA_GATE_NOT_PASSED');
 assert.equal(runIsolatedAgentGovernanceRehearsal({...base,qaResult:{...qaEvidence(true),revision_sha256:'b'.repeat(64)}}).code,'QA_REVISION_MISMATCH');
 assert.equal(runIsolatedAgentGovernanceRehearsal({...base,developerPatch:patchEvidence(['ru-migration/../supabase/functions/moderate/index.ts'])}).code,'DEVELOPER_SCOPE_VIOLATION');
});

test('legal consultation is checked before the developer stage and unresolved scope cannot use the fast path', () => {
  const base={pulls:[{number:167,draft:false,files:[]}],queue:{failed_last_24h:0,expired_leases:0},warnings:[],
    legalConsultation:legalEvidence(),developerPatch:patchEvidence(['ru-migration/app/backend/server.mjs']),qaResult:qaEvidence(true)};
  const noConsultation={...base,legalConsultation:legalEvidence('FAM_RU',sha,'unknown')};
  noConsultation.legalConsultation.guidance=null;
  assert.equal(runIsolatedAgentGovernanceRehearsal({...noConsultation,developerPatch:{broken:true}}).code,'LEGAL_CONSULTATION_REQUIRED');
  const mismatch={...base,legalConsultation:legalEvidence('FAM_CURRENT')};
  assert.equal(runIsolatedAgentGovernanceRehearsal(mismatch).code,'LEGAL_SCOPE_MISMATCH');
  const currentSafe={...base,legalConsultation:legalEvidence('FAM_CURRENT',sha,'none')};
  const currentResult=evaluateLegalConsultation(currentSafe.legalConsultation);
  assert.equal(currentResult.ok,true);
  assert.equal(currentResult.status,'not_required');
  assert.equal(currentResult.live_cutover_authorized,false);
});
