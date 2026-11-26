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

for(const [name,mutate] of [
 ['non-synthetic UUID',x=>x.notifications[0].user_id='11111111-1111-4111-8111-111111111111'],
 ['boolean identifier',x=>x.notifications[0].notification_id=true],
 ['raw reason text',x=>x.suspensions[0].reason_code='unapproved free text'],
 ['raw audit entity',x=>x.admin_audit[0].entity_id='unapproved free text'],
 ['raw incident category',x=>x.safety_incidents[0].category='unapproved free text'],
 ['duplicate with reordered fields',x=>x.notifications.push(Object.fromEntries(Object.entries(x.notifications[0]).reverse()))],
 ['unverified inventory claim',x=>x.inventory_digest='synthetic:unverified']
])test('operational rejects '+name,()=>{const x=fixture();mutate(x);assert.equal(verifySyntheticOperationalSnapshot(x).ok,false);});
test('canonical reconciliation is independent of row and field ordering',()=>{const x=fixture();x.notifications.push({...x.notifications[0],notification_id:'synthetic-notification-2'});const y=structuredClone(x);y.notifications.reverse();for(const key of Object.keys(y).filter(k=>Array.isArray(y[k])))y[key]=y[key].map(r=>Object.fromEntries(Object.entries(r).reverse()));const a=compareSyntheticOperationalSnapshots(x,y,y);const b=compareSyntheticOperationalSnapshots(y,x,x);assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.inventory_digest,b.inventory_digest);});
