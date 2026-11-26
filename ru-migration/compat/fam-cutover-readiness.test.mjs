import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFamCutoverReadiness } from './fam-cutover-readiness.mjs';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const observed = '2026-11-27T00:00:00.000Z';
const evaluationAt = '2026-11-27T12:00:00.000Z';
const receipt = (kind, name) => {
  const subject_sha256 = sha(`subject:${name}`);
  const canonical = JSON.stringify({ kind, subject_sha256, observed_at: observed, producer: 'independent-test-reporter' });
  return { kind, subject_sha256, evidence_sha256: sha(canonical), observed_at: observed, producer: 'independent-test-reporter' };
};
const ready = () => ({
  target_mode: 'real-cutover',
  source_inventory: receipt('inventory', 'source'),
  ru_schema_inventory: receipt('inventory', 'ru'),
  ci_evidence: receipt('ci', 'ci'),
  security_evidence: receipt('security', 'security'),
  mobile_evidence: receipt('mobile', 'mobile'),
  operational_evidence: receipt('operational', 'operational'),
  legacy_identity_evidence: receipt('identity', 'legacy'),
  yandex_identity_evidence: receipt('identity', 'yandex'),
  cloud_evidence: receipt('cloud', 'cloud'),
  owner_authorization: {
    authorization_id: 'owner-cutover-approved-20261127',
    subject_sha256: sha('approved-cutover-subject'),
    observed_at: observed,
    producer: 'owner-offline-attestation',
    scope: 'real-cutover',
  },
});

test('cutover gate requires every hard readiness gate', () => {
  assert.deepEqual(evaluateFamCutoverReadiness(ready(), { evaluation_at: evaluationAt }), {
    ok: true,
    code: 'CUTOVER_AUTHORIZATION_READY',
    live_cutover_authorized: true,
    blockers: [],
  });
});

test('cutover gate stays fail-closed for missing infrastructure or owner approval', () => {
  for (const mutation of [
    value => { value.cloud_evidence = receipt('mobile', 'wrong'); },
    value => { value.owner_authorization.scope = 'synthetic'; },
    value => { value.legacy_identity_evidence.observed_at = '2026-01-01T00:00:00.000Z'; },
    value => { value.target_mode = 'synthetic'; },
  ]) {
    const input = ready();
    mutation(input);
    const result = evaluateFamCutoverReadiness(input, { evaluation_at: evaluationAt });
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
