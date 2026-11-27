import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSyntheticOperationalEnvelope,
  decodeSyntheticOperationalEnvelope,
} from './synthetic-operational-envelope.mjs';

function fixture() {
  const created = '2026-11-24T12:00:00.000Z';
  const expires = '2026-11-25T12:00:00.000Z';
  return {
    snapshot_id: 'synthetic-operational-envelope',
    notifications: [{ notification_id: 'synthetic-notification-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', kind: 'message', read: false, created_at: created }],
    suspensions: [{ suspension_id: 'synthetic-suspension-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', active: true, reason_code: 'synthetic-rule', expires_at: expires }],
    deletion_requests: [{ request_id: 'synthetic-deletion-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', status: 'pending', created_at: created }],
    role_requests: [{ request_id: 'synthetic-role-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', role: 'council_member', status: 'pending', created_at: created }],
    admin_audit: [{ audit_id: 'synthetic-audit-1', school_id: 'synthetic-school-1', actor_id: 'synthetic-admin-1', action: 'revoke_role', entity_id: 'synthetic-user-1', created_at: created }],
    safety_incidents: [{ incident_id: 'synthetic-safety-1', school_id: 'synthetic-school-1', actor_id: 'synthetic-user-1', category: 'synthetic-category', level: 'medium', created_at: created }],
  };
}

test('operational envelope round-trips synthetic state without live authorization', () => {
  const encoded = encodeSyntheticOperationalEnvelope(fixture());
  assert.equal(encoded.ok, true);
  assert.equal(encoded.live_cutover_authorized, false);
  const decoded = decodeSyntheticOperationalEnvelope(encoded.bytes, encoded.sha256);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.snapshot.snapshot_id, 'synthetic-operational-envelope');
  assert.equal(decoded.live_cutover_authorized, false);
});

test('operational envelope rejects corrupt bytes and wrong digest', () => {
  const encoded = encodeSyntheticOperationalEnvelope(fixture());
  const corrupted = Buffer.concat([encoded.bytes.subarray(0, encoded.bytes.length - 1), Buffer.from(' ')]);
  assert.equal(decodeSyntheticOperationalEnvelope(corrupted, encoded.sha256).code, 'OPERATIONAL_ENVELOPE_DIGEST_MISMATCH');
  assert.equal(decodeSyntheticOperationalEnvelope(encoded.bytes, 'f'.repeat(64)).code,
    'OPERATIONAL_ENVELOPE_DIGEST_MISMATCH');
});
