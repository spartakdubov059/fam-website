import { evaluateLegalCutoverEvidence } from './fam-legal-cutover-evidence.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';

const exactKeys = (value, keys) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

const SHA = /^[a-f0-9]{64}$/;
const ISO = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const hex = value => typeof value === 'string' && SHA.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');

function validEvidenceReceipt(receipt, now, maxAgeMs) {
  if (!exactKeys(receipt, ['kind', 'subject_sha256', 'evidence_sha256', 'observed_at', 'producer']))
    return false;
  if (!['ci', 'security', 'mobile', 'inventory', 'operational', 'identity', 'cloud'].includes(receipt.kind)
      || !hex(receipt.subject_sha256) || !hex(receipt.evidence_sha256)
      || typeof receipt.producer !== 'string' || receipt.producer.length < 3
      || receipt.producer.length > 200 || !ISO(receipt.observed_at)) return false;
  const age = now - Date.parse(receipt.observed_at);
  return age >= 0 && age <= maxAgeMs;
}

function compareDigest(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  const canonical = JSON.stringify({
    kind: receipt.kind,
    subject_sha256: receipt.subject_sha256,
    observed_at: receipt.observed_at,
    producer: receipt.producer,
  });
  return timingSafeEqual(
    Buffer.from(receipt.evidence_sha256, 'hex'),
    Buffer.from(hash(canonical), 'hex'),
  );
}

export function evaluateFamCutoverReadiness(input, options = {}) {
  const fail = blockers => ({ ok: false, code: 'CUTOVER_NOT_AUTHORIZED', live_cutover_authorized: false, blockers });
  if (!exactKeys(input, [
    'target_mode', 'source_inventory', 'ru_schema_inventory', 'ci_evidence',
    'security_evidence', 'mobile_evidence', 'operational_evidence',
    'legacy_identity_evidence', 'yandex_identity_evidence', 'cloud_evidence',
    'owner_authorization', 'legal_evidence',
  ])) return fail(['invalid_readiness_manifest']);
  if (input.target_mode !== 'real-cutover') return fail(['synthetic readiness cannot authorize real cutover']);
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  if (!ISO(options.evaluation_at) && typeof options.evaluation_at !== 'undefined') return fail(['invalid evaluation time']);
  const evaluatedAt = typeof options.evaluation_at === 'string'
    ? Date.parse(options.evaluation_at)
    : now;
  if (!Number.isSafeInteger(evaluatedAt)) return fail(['invalid evaluation time']);
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  const blockers = [];
  const receiptByKind = {
    source_inventory: 'inventory',
    ru_schema_inventory: 'inventory',
    ci_evidence: 'ci',
    security_evidence: 'security',
    mobile_evidence: 'mobile',
    operational_evidence: 'operational',
    legacy_identity_evidence: 'identity',
    yandex_identity_evidence: 'identity',
    cloud_evidence: 'cloud',
  };
  for (const [key, kind] of Object.entries(receiptByKind)) {
    const receipt = input[key];
    if (!validEvidenceReceipt(receipt, evaluatedAt, maxAgeMs)) {
      blockers.push(`invalid or stale ${key}`);
    } else if (receipt.kind !== kind) {
      blockers.push(`wrong evidence kind for ${key}`);
    } else if (!compareDigest(receipt)) {
      blockers.push(`undigested ${key}`);
    }
  }
  const owner = input.owner_authorization;
  if (!exactKeys(owner, ['authorization_id', 'subject_sha256', 'observed_at', 'producer', 'scope'])
      || !/^owner-cutover-[a-z0-9_-]{8,128}$/i.test(owner.authorization_id)
      || !hex(owner.subject_sha256) || !ISO(owner.observed_at)
      || owner.scope !== 'real-cutover'
      || typeof owner.producer !== 'string' || owner.producer.length < 3 || owner.producer.length > 200
      || /synthetic/i.test(owner.authorization_id)
      || evaluatedAt - Date.parse(owner.observed_at) < 0
      || evaluatedAt - Date.parse(owner.observed_at) > maxAgeMs) {
    blockers.push('owner cutover authorization is missing or stale');
  }
  const legal = evaluateLegalCutoverEvidence(input.legal_evidence, owner?.subject_sha256, evaluatedAt);
  blockers.push(...legal.blockers);
  // This offline rehearsal cannot authenticate technical receipts or an owner's authority.
  blockers.push('trusted technical and owner authorization verification not implemented');
  return fail(blockers);
}
