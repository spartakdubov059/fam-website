import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFamCutoverReadiness } from './fam-cutover-readiness.mjs';

const ready = () => ({
  source_migration_count: 90,
  ru_schema_table_count: 40,
  ci_green: true,
  independent_security_review: true,
  mobile_audit: true,
  operational_reconciliation: true,
  legacy_identity_proofs: true,
  yandex_identity_proofs: true,
  cloud_infrastructure_configured: true,
  owner_cutover_authorization: true,
});

test('cutover gate requires every hard readiness gate', () => {
  assert.deepEqual(evaluateFamCutoverReadiness(ready()), {
    ok: true,
    code: 'CUTOVER_AUTHORIZATION_READY',
    live_cutover_authorized: true,
    blockers: [],
  });
});

test('cutover gate stays fail-closed for missing infrastructure or owner approval', () => {
  for (const mutation of [
    value => { value.cloud_infrastructure_configured = false; },
    value => { value.owner_cutover_authorization = false; },
    value => { value.legacy_identity_proofs = false; },
    value => { value.ci_green = false; },
  ]) {
    const input = ready();
    mutation(input);
    const result = evaluateFamCutoverReadiness(input);
    assert.equal(result.ok, false);
    assert.equal(result.live_cutover_authorized, false);
    assert.equal(result.code, 'CUTOVER_NOT_AUTHORIZED');
    assert.ok(result.blockers.length);
  }
});

test('cutover gate rejects malformed readiness manifests', () => {
  assert.deepEqual(evaluateFamCutoverReadiness({ ci_green: true }).blockers,
    ['invalid_readiness_manifest']);
  const input = ready();
  input.extra = true;
  assert.deepEqual(evaluateFamCutoverReadiness(input).blockers,
    ['invalid_readiness_manifest']);
});
