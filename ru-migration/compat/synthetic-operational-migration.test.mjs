import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifySyntheticOperationalSnapshot,
  compareSyntheticOperationalSnapshots,
} from './synthetic-operational-migration.mjs';

function fixture() {
  const created = '2026-11-24T12:00:00.000Z';
  const expires = '2026-11-25T12:00:00.000Z';
  return {
    snapshot_id: 'synthetic-operational-1',
    inventory_digest: 'synthetic',
    notifications: [{ notification_id: 'synthetic-notification-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', kind: 'message', read: false, created_at: created }],
    suspensions: [{ suspension_id: 'synthetic-suspension-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', active: true, reason_code: 'synthetic-rule', expires_at: expires }],
    deletion_requests: [{ request_id: 'synthetic-deletion-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', status: 'pending', created_at: created }],
    role_requests: [{ request_id: 'synthetic-role-1', user_id: 'synthetic-user-1', school_id: 'synthetic-school-1', role: 'council_member', status: 'pending', created_at: created }],
    admin_audit: [{ audit_id: 'synthetic-audit-1', school_id: 'synthetic-school-1', actor_id: 'synthetic-admin-1', action: 'revoke_role', entity_id: 'synthetic-user-1', created_at: created }],
    safety_incidents: [{ incident_id: 'synthetic-safety-1', school_id: 'synthetic-school-1', actor_id: 'synthetic-user-1', category: 'synthetic-category', level: 'medium', created_at: created }],
  };
}

test('operational snapshot preserves notification, suspension, deletion, role and audit sections', () => {
  const source = fixture();
  assert.equal(verifySyntheticOperationalSnapshot(source).ok, true);
  assert.equal(compareSyntheticOperationalSnapshots(source, structuredClone(source), structuredClone(source)).ok, true);
});

test('operational snapshot rejects tampered target state and unknown snapshot sections', () => {
  const source = fixture();
  const target = structuredClone(source);
  target.suspensions[0].active = false;
  assert.deepEqual(compareSyntheticOperationalSnapshots(source, target, structuredClone(source)),
    { ok: false, code: 'OPERATIONAL_STATE_MISMATCH', table: 'suspensions', live_cutover_authorized: false });
  const extra = { ...source, extra_section: [] };
  assert.equal(verifySyntheticOperationalSnapshot(extra).code, 'INVALID_OPERATIONAL_SNAPSHOT');
});
