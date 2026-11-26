import test from 'node:test';
import assert from 'node:assert/strict';
import { runIsolatedAgentGovernanceRehearsal } from './fam-agent-governance-rehearsal.mjs';

test('isolated full governance pipeline connects inspector developer QA arbiter integrator recruiter', () => {
  const result = runIsolatedAgentGovernanceRehearsal({
    pulls: [
      { number: 167, draft: false, files: ['ru-migration/app/backend/server.mjs', 'ru-migration/compat/integration-ydb.mjs'] },
      { number: 168, draft: true, files: ['ru-migration/app/backend/server.mjs', 'docs/test.md'] },
    ],
    queue: { failed_last_24h: 4, expired_leases: 1 },
    warnings: [{ code: 'repeated_failures', severity: 'high', count: 3 }],
    developerPatch: { approved_scope: ['ru-migration/app/backend/server.mjs'], has_patch: true, synthetic_only: true },
    qaResult: { passed: true, tests_run: 788, production_access: false },
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
    developerPatch: { approved_scope: ['ru-migration/app/backend/server.mjs'], has_patch: true, synthetic_only: true },
    qaResult: { passed: true, tests_run: 32, production_access: false },
  };
  const failedQa = { ...base, qaResult: { passed: false, tests_run: 32, production_access: false } };
  assert.equal(runIsolatedAgentGovernanceRehearsal(failedQa).code, 'QA_GATE_NOT_PASSED');
  const scope = { ...base, developerPatch: { approved_scope: ['supabase/functions/moderate/index.ts'], has_patch: true, synthetic_only: true } };
  assert.equal(runIsolatedAgentGovernanceRehearsal(scope).code, 'DEVELOPER_SCOPE_VIOLATION');
});
