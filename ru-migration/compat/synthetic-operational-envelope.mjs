import { createHash, timingSafeEqual } from 'node:crypto';
import { verifySyntheticOperationalSnapshot } from './synthetic-operational-migration.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export function encodeSyntheticOperationalEnvelope(snapshot) {
  if (!snapshot || !verifySyntheticOperationalSnapshot(snapshot).ok) {
    return { ok: false, code: 'INVALID_OPERATIONAL_ENVELOPE', live_cutover_authorized: false };
  }
  const envelope = {
    version: 1,
    snapshot,
  };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (bytes.length > MAX_BYTES) {
    return { ok: false, code: 'OPERATIONAL_ENVELOPE_TOO_LARGE', live_cutover_authorized: false };
  }
  return {
    ok: true,
    bytes,
    sha256: hash(bytes),
    live_cutover_authorized: false,
  };
}

export function decodeSyntheticOperationalEnvelope(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES
      || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return { ok: false, code: 'INVALID_OPERATIONAL_ENVELOPE_INPUT', live_cutover_authorized: false };
  }
  const actual = Buffer.from(hash(bytes), 'hex');
  const expected = Buffer.from(expectedSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, code: 'OPERATIONAL_ENVELOPE_DIGEST_MISMATCH', live_cutover_authorized: false };
  }
  try {
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!exact(envelope, ['version', 'snapshot']) || envelope.version !== 1) {
      return { ok: false, code: 'UNSUPPORTED_OPERATIONAL_ENVELOPE', live_cutover_authorized: false };
    }
    if (!verifySyntheticOperationalSnapshot(envelope.snapshot).ok) {
      return { ok: false, code: 'INVALID_OPERATIONAL_ENVELOPE', live_cutover_authorized: false };
    }
    return {
      ok: true,
      snapshot: envelope.snapshot,
      sha256: expectedSha256,
      live_cutover_authorized: false,
    };
  } catch {
    return { ok: false, code: 'INVALID_OPERATIONAL_ENVELOPE_FORMAT', live_cutover_authorized: false };
  }
}
