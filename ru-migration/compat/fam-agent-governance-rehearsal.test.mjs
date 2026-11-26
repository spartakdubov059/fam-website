import test from 'node:test';
import assert from 'node:assert/strict';
import { runIsolatedAgentGovernanceRehearsal } from './fam-agent-governance-rehearsal.mjs';

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

test('isolated full governance pipeline connects inspector developer QA arbiter integrator recruiter', () => {
  const result = runIsolatedAgentGovernanceRehearsal({
    pulls: [
      { number: 167, draft: false, files: ['ru-migration/app/backend/server.mjs', 'ru-migration/compat/integration-ydb.mjs'] },
      { number: 168, draft: true, files: ['ru-migration/app/backend/server.mjs', 'docs/test.md'] },
    ],
    queue: { failed_last_24h: 4, expired_leases: 1 },
    warnings: [{ code: 'repeated_failures', severity: 'high', count: 3 }],
    developerPatch: patchEvidence(['ru-migration/app/backend/server.mjs']),
    qaResult: qaEvidence(true),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stages.map(stage => stage.role),
    ['inspector', 'developer', 'qa', 'arbiter', 'integrator', 'recruiter']);
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
    developerPatch: patchEvidence(['ru-migration/app/backend/server.mjs']),
    qaResult: qaEvidence(true),
  };
  const failedQa = { ...base, qaResult: qaEvidence(false) };
  assert.equal(runIsolatedAgentGovernanceRehearsal(failedQa).code, 'QA_GATE_NOT_PASSED');
  const scope = { ...base, developerPatch: patchEvidence(['supabase/functions/moderate/index.ts']) };
  assert.equal(runIsolatedAgentGovernanceRehearsal(scope).code, 'DEVELOPER_SCOPE_VIOLATION');
});
