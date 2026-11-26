import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluateFamCutoverReadiness } from './fam-cutover-readiness.mjs';
import { LEGAL_CUTOVER_CRITERIA, evaluateLegalCutoverEvidence } from './fam-legal-cutover-evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const observed = '2026-11-27T00:00:00.000Z';
const evaluationAt = '2026-11-27T12:00:00.000Z';
const receipt = (kind, name) => {
  const subject_sha256 = sha(`subject:${name}`);
  return { kind, subject_sha256, evidence_sha256: sha(`evidence:${name}`), observed_at: observed, producer: 'independent-test-reporter' };
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
  legal_evidence: {
    version: 1,
    release_sha256: sha('approved-cutover-subject'),
    receipts: LEGAL_CUTOVER_CRITERIA.map(({id}) => ({
      criterion: id,
      release_sha256: sha('approved-cutover-subject'),
      artifact_sha256: sha('synthetic:' + id),
      reviewed_at: observed,
      status: 'reviewed',
    })),
  },
  owner_authorization: {
    authorization_id: 'owner-cutover-approved-20261127',
    subject_sha256: sha('approved-cutover-subject'),
    observed_at: observed,
    producer: 'owner-offline-attestation',
    scope: 'real-cutover',
  },
});

test('cutover gate always blocks real cutover until external legal and technical verification exists', () => {
  const result = evaluateFamCutoverReadiness(ready(), { evaluation_at: evaluationAt });
  assert.equal(result.ok, false);
  assert.equal(result.live_cutover_authorized, false);
  assert.ok(result.blockers.includes('legal: trusted operator and school evidence verification not implemented'));
  assert.ok(result.blockers.includes('trusted technical and owner authorization verification not implemented'));
});

test('cutover gate stays fail-closed for synthetic mode and stale evidence', () => {
  const synthetic = ready();
  synthetic.target_mode = 'synthetic';
  assert.equal(evaluateFamCutoverReadiness(synthetic, { evaluation_at: evaluationAt }).live_cutover_authorized, false);
  const stale = ready();
  stale.ci_evidence.observed_at = '2026-01-01T00:00:00.000Z';
  assert.equal(evaluateFamCutoverReadiness(stale, { evaluation_at: evaluationAt }).live_cutover_authorized, false);
});

test('cutover gate rejects malformed readiness manifests', () => {
  assert.deepEqual(evaluateFamCutoverReadiness({ ci_green: true }).blockers, ['invalid_readiness_manifest']);
  const input = ready();
  input.extra = true;
  assert.deepEqual(evaluateFamCutoverReadiness(input).blockers, ['invalid_readiness_manifest']);
});

for (const [label, mutate] of [
  ['missing localization', x => { x.receipts = x.receipts.filter(r => r.criterion !== 'localization'); }],
  ['wrong release', x => { x.release_sha256 = sha('other'); }],
  ['duplicate', x => { x.receipts[1] = x.receipts[0]; }],
  ['expired', x => { x.receipts[0].reviewed_at = '2026-01-01T00:00:00.000Z'; }],
  ['future', x => { x.receipts[0].reviewed_at = '2026-12-01T00:00:00.000Z'; }],
  ['invalid hash', x => { x.receipts[0].artifact_sha256 = 'not-a-digest'; }],
  ['unreviewed', x => { x.receipts[0].status = 'pending'; }],
  ['extra raw field', x => { x.receipts[0].raw_document = 'synthetic prohibited field'; }],
]) {
  test('legal gate blocks ' + label, () => {
    const input = ready();
    mutate(input.legal_evidence);
    const result = evaluateLegalCutoverEvidence(input.legal_evidence, input.owner_authorization.subject_sha256, Date.parse(evaluationAt));
    assert.equal(result.ok, false);
    assert.equal(result.live_cutover_authorized, false);
  });
}
