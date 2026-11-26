import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { encodeSyntheticOperationalEnvelope, decodeSyntheticOperationalEnvelope } from './synthetic-operational-envelope.mjs';

const school = 'synthetic-operational-school';
const target = 'synthetic-operational-target';
const actor = 'synthetic-operational-admin';
const created = '2026-11-24T12:00:00.000Z';
const expires = '2026-11-25T12:00:00.000Z';
const createdAt = new Date(created);
const expiresAt = new Date(expires);
const driver = new Driver('grpc://127.0.0.1:2136/local');

async function seedOperationalTables(sql, snapshot) {
  const suspension = snapshot.suspensions[0];
  const deletion = snapshot.deletion_requests[0];
  const role = snapshot.role_requests[0];
  const roleAudit = snapshot.role_audit[0];
  const adminAudit = snapshot.admin_audit[0];
  const safety = snapshot.safety_incidents[0];
  await sql.begin(async tx => {
    for (const notification of snapshot.notifications) {
      // This table stores read markers only; unread notifications have no row.
      if (!notification.read) continue;
      await tx`INSERT INTO fam_notification_reads
        (user_id, notification_key, read_at)
        VALUES (${notification.user_id}, ${notification.notification_id}, ${createdAt});`;
    }
    await tx`INSERT INTO fam_account_suspensions
      (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at, lifted_by, lifted_at)
      VALUES (${suspension.school_id}, ${suspension.user_id}, ${suspension.suspension_id}, ${suspension.target_role}, Unwrap(CAST(${suspension.duration_hours} AS Uint32)), ${suspension.reason_code}, ${suspension.status}, ${suspension.issued_by}, ${createdAt}, ${expiresAt}, ${suspension.lifted_by}, ${suspension.lifted_at});`;
    await tx`INSERT INTO fam_account_suspension_open
      (target_id, school_id, suspension_id, created_at)
      VALUES (${target}, ${suspension.school_id}, ${suspension.suspension_id}, ${createdAt});`;
    await tx`INSERT INTO fam_account_deletion_requests
      (request_id, school_id, requester_id, target_id, target_role, reason_code, reason, status, reviewed_by, reviewed_at, review_note, created_at)
      VALUES (${deletion.request_id}, ${deletion.school_id}, ${deletion.requester_id}, ${deletion.target_id}, ${deletion.target_role}, ${deletion.reason_code}, ${deletion.reason}, ${deletion.status}, ${deletion.reviewed_by}, ${deletion.reviewed_at}, ${deletion.review_note}, ${createdAt});`;
    await tx`INSERT INTO fam_account_deletion_open
      (target_id, request_id, school_id, created_at)
      VALUES (${target}, ${deletion.request_id}, ${deletion.school_id}, ${createdAt});`;
    await tx`INSERT INTO fam_school_role_requests
      (issuer, subject, request_id, user_id, school_id, requested_role, status, review_started_by, review_started_at, reviewed_by, reviewed_at, review_note, created_at)
      VALUES (${role.issuer}, ${role.subject}, ${role.request_id}, ${role.user_id}, ${role.school_id}, ${role.role}, ${role.status}, ${role.review_started_by}, ${role.review_started_at}, ${role.reviewed_by}, ${role.reviewed_at}, ${role.review_note}, ${createdAt});`;
    await tx`INSERT INTO fam_school_role_request_audit
      (event_id, request_id, school_id, actor_id, requested_role, action, status, created_at)
      VALUES (${roleAudit.event_id}, ${role.request_id}, ${role.school_id}, ${roleAudit.actor_id}, ${role.role}, ${roleAudit.action}, ${roleAudit.status}, ${createdAt});`;
    await tx`INSERT INTO fam_school_admin_audit
      (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
      VALUES (${adminAudit.audit_id}, ${adminAudit.school_id}, ${adminAudit.actor_id}, ${adminAudit.entity_id}, ${adminAudit.action}, 'school_admin', ${createdAt});`;
    await tx`INSERT INTO fam_safety_incidents
      (school_id, pair_fingerprint, source_kind, category, incident_id, severity, created_at, reviewed_at, reviewed_by, actor_id, target_id, source_origin, evidence_excerpt)
      VALUES (${safety.school_id}, ${safety.pair_fingerprint}, ${safety.source_kind}, ${safety.category}, ${safety.incident_id}, ${safety.level}, ${createdAt}, ${safety.reviewed_at}, ${safety.reviewed_by}, ${safety.actor_id}, ${safety.target_id}, ${safety.source_origin}, ${safety.evidence_excerpt});`;
  });
}

async function verifyOperationalTables(sql, snapshot) {
  const notification = (await sql`SELECT notification_key, read_at FROM fam_notification_reads WHERE user_id = ${target};`)[0];
  const suspension = (await sql`SELECT target_id, school_id, suspension_id, target_role, duration_hours, reason, status, issued_by, lifted_by, lifted_at FROM fam_account_suspensions WHERE target_id = ${target};`)[0];
  const openSuspension = (await sql`SELECT suspension_id, school_id FROM fam_account_suspension_open WHERE target_id = ${target};`)[0];
  const deletion = (await sql`SELECT request_id, school_id, requester_id, target_id, target_role, reason_code, reason, status, reviewed_by, reviewed_at, review_note FROM fam_account_deletion_requests WHERE target_id = ${target};`)[0];
  const openDeletion = (await sql`SELECT request_id, school_id FROM fam_account_deletion_open WHERE target_id = ${target};`)[0];
  const role = (await sql`SELECT issuer, subject, request_id, user_id, school_id, requested_role, status, review_started_by, review_started_at, reviewed_by, reviewed_at, review_note FROM fam_school_role_requests WHERE user_id = ${target};`)[0];
  const roleAudit = (await sql`SELECT actor_id, action, status FROM fam_school_role_request_audit WHERE request_id = 'synthetic-role-1';`)[0];
  const adminAudit = (await sql`SELECT actor_id, target_id, action, previous_role FROM fam_school_admin_audit WHERE event_id = 'synthetic-admin-audit-1';`)[0];
  const safety = (await sql`SELECT pair_fingerprint, source_kind, category, severity, reviewed_by, actor_id, target_id, source_origin, evidence_excerpt FROM fam_safety_incidents WHERE school_id = ${school};`)[0];

  const expectedReadKeys = snapshot.notifications.filter(row => row.read).map(row => row.notification_id).sort();
  assert.deepEqual(notification.map(row => row.notification_key).sort(), expectedReadKeys);
  assert.equal(suspension.length, 1);
  assert.equal(openSuspension.length, 1);
  assert.equal(deletion.length, 1);
  assert.equal(openDeletion.length, 1);
  assert.equal(role.length, 1);
  assert.equal(roleAudit.length, 1);
  assert.equal(adminAudit.length, 1);
  assert.equal(safety.length, 1);
  assert.deepEqual(suspension.map(row => [row.school_id, row.suspension_id, row.target_role, Number(row.duration_hours), row.reason, row.status, row.issued_by, row.lifted_by, row.lifted_at]), [[school, 'synthetic-suspension-1', 'student', 24, 'synthetic-rule', 'active', actor, null, null]]);
  assert.deepEqual(deletion.map(row => [row.school_id, row.requester_id, row.target_id, row.target_role, row.reason_code, row.reason, row.status, row.reviewed_by, row.reviewed_at, row.review_note]), [[school, actor, target, 'student', 'other', 'synthetic:reason', 'pending', null, null, null]]);
  assert.deepEqual(role.map(row => [row.issuer, row.subject, row.school_id, row.request_id, row.requested_role, row.status, row.review_started_by, row.review_started_at, row.reviewed_by, row.reviewed_at, row.review_note]), [['https://synthetic.invalid', 'synthetic-subject-1', school, 'synthetic-role-1', 'council_member', 'pending', null, null, null, null, null]]);
  assert.deepEqual(roleAudit.map(row => [row.actor_id, row.action, row.status]), [[actor, 'submitted', 'pending']]);
  assert.deepEqual(adminAudit.map(row => [row.actor_id, row.target_id, row.action, row.previous_role]), [[actor, target, 'revoke_role', 'school_admin']]);
  assert.deepEqual(safety.map(row => [row.pair_fingerprint, row.source_kind, row.category, row.severity, row.reviewed_by, row.actor_id, row.target_id, row.source_origin, row.evidence_excerpt]), [['synthetic-fingerprint-1', 'message', 'synthetic-category', 'medium', null, target, null, null, null]]);
}

try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => {
    const statement = client(strings, ...values);
    statement.on('error', () => {});
    return statement;
  };
  sql.begin = client.begin.bind(client);

  const operationalSnapshot = {
    snapshot_id: 'synthetic-operational-restore',
    notifications: [
      { notification_id: 'synthetic-notification-1', user_id: target, school_id: school, kind: 'message', read: true, created_at: created },
      { notification_id: 'synthetic-notification-2', user_id: target, school_id: school, kind: 'listing', read: false, created_at: created },
    ],
    suspensions: [{ suspension_id: 'synthetic-suspension-1', user_id: target, school_id: school, target_role: 'student', duration_hours: 24, reason_code: 'synthetic-rule', status: 'active', issued_by: actor, expires_at: expires, lifted_by: null, lifted_at: null }],
    deletion_requests: [{ request_id: 'synthetic-deletion-1', requester_id: actor, target_id: target, user_id: target, school_id: school, target_role: 'student', reason_code: 'other', reason: 'synthetic:reason', status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null, created_at: created }],
    role_requests: [{ issuer: 'https://synthetic.invalid', subject: 'synthetic-subject-1', request_id: 'synthetic-role-1', user_id: target, school_id: school, role: 'council_member', status: 'pending', review_started_by: null, review_started_at: null, reviewed_by: null, reviewed_at: null, review_note: null, created_at: created }],
    role_audit: [{ event_id: 'synthetic-role-audit-1', actor_id: actor, action: 'submitted', status: 'pending' }],
    admin_audit: [{ audit_id: 'synthetic-admin-audit-1', school_id: school, actor_id: actor, action: 'revoke_role', entity_id: target, created_at: created }],
    safety_incidents: [{ incident_id: 'synthetic-safety-1', school_id: school, actor_id: target, category: 'synthetic-category', level: 'medium', pair_fingerprint: 'synthetic-fingerprint-1', source_kind: 'message', reviewed_at: null, reviewed_by: null, target_id: null, source_origin: null, evidence_excerpt: null, created_at: created }],
  };
  const envelope = encodeSyntheticOperationalEnvelope(operationalSnapshot);
  assert.equal(envelope.ok, true);
  const decoded = decodeSyntheticOperationalEnvelope(envelope.bytes, envelope.sha256);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.snapshot, operationalSnapshot);

  await sql.begin(async tx => {
    await tx`DELETE FROM fam_notification_reads WHERE user_id = ${target};`;
    await tx`DELETE FROM fam_account_suspensions WHERE target_id = ${target};`;
    await tx`DELETE FROM fam_account_suspension_open WHERE target_id = ${target};`;
    await tx`DELETE FROM fam_account_deletion_requests WHERE target_id = ${target};`;
    await tx`DELETE FROM fam_account_deletion_open WHERE target_id = ${target};`;
    await tx`DELETE FROM fam_school_role_requests WHERE user_id = ${target};`;
    await tx`DELETE FROM fam_school_role_request_audit WHERE request_id = 'synthetic-role-1';`;
    await tx`DELETE FROM fam_school_admin_audit WHERE event_id = 'synthetic-admin-audit-1';`;
    await tx`DELETE FROM fam_safety_incidents WHERE school_id = ${school};`;
  });

  await seedOperationalTables(sql, decoded.snapshot);
  await verifyOperationalTables(sql, operationalSnapshot);

  await assert.rejects(
    () => sql.begin(async tx => {
      await tx`DELETE FROM fam_notification_reads WHERE user_id = ${target};`;
      await tx`INSERT INTO fam_notification_reads
        (user_id, notification_key, read_at)
        VALUES (${target}, 'synthetic:notification:rollback', ${createdAt});`;
      throw new Error('synthetic operational restore interruption');
    }),
    error => error?.message === 'Transaction failed.' && error.cause?.message === 'synthetic operational restore interruption',
  );
  const notificationAfterRollback = (await sql`SELECT notification_key FROM fam_notification_reads WHERE user_id = ${target};`)[0];
  const expectedReadKeys = operationalSnapshot.notifications.filter(row => row.read).map(row => row.notification_id).sort();
  assert.deepEqual(notificationAfterRollback.map(row => row.notification_key).sort(), expectedReadKeys);
  await verifyOperationalTables(sql, operationalSnapshot);

  console.log('YDB_SYNTHETIC_OPERATIONAL_RESTORE_PASS: notifications, suspensions, deletion/role requests, audits and safety incidents restored atomically');
} finally {
  await driver.close();
}
