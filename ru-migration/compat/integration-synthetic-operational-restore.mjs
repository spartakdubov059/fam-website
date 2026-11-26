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

async function seedOperationalTables(sql) {
  await sql.begin(async tx => {
    await tx`INSERT INTO fam_notification_reads
      (user_id, notification_key, read_at)
      VALUES (${target}, 'synthetic:notification:1', ${createdAt});`;
    await tx`INSERT INTO fam_account_suspensions
      (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at)
      VALUES (${school}, ${target}, 'synthetic-suspension-1', 'student', Unwrap(CAST(24 AS Uint32)), 'synthetic-rule', 'issued',       ${actor}, ${createdAt}, ${expiresAt});`;
    await tx`INSERT INTO fam_account_suspension_open
      (target_id, school_id, suspension_id, created_at)
      VALUES (${target}, ${school}, 'synthetic-suspension-1', ${createdAt});`;
    await tx`INSERT INTO fam_account_deletion_requests
      (request_id, school_id, requester_id, target_id, target_role, reason_code, reason, status, created_at)
      VALUES ('synthetic-deletion-1', ${school}, ${actor}, ${target}, 'student', 'other', 'synthetic:reason', 'pending', ${createdAt});`;
    await tx`INSERT INTO fam_account_deletion_open
      (target_id, request_id, school_id, created_at)
      VALUES (${target}, 'synthetic-deletion-1', ${school}, ${createdAt});`;
    await tx`INSERT INTO fam_school_role_requests
      (issuer, subject, request_id, user_id, school_id, requested_role, status, created_at)
      VALUES ('https://synthetic.invalid', 'synthetic-subject-1', 'synthetic-role-1', ${target}, ${school}, 'council_member', 'pending', ${createdAt});`;
    await tx`INSERT INTO fam_school_role_request_audit
      (event_id, request_id, school_id, actor_id, requested_role, action, status, created_at)
      VALUES ('synthetic-role-audit-1', 'synthetic-role-1', ${school}, ${actor}, 'council_member', 'submitted', 'pending', ${createdAt});`;
    await tx`INSERT INTO fam_school_admin_audit
      (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
      VALUES ('synthetic-admin-audit-1', ${school}, ${actor}, ${target}, 'revoke_role', 'school_admin', ${createdAt});`;
    await tx`INSERT INTO fam_safety_incidents
      (school_id, pair_fingerprint, source_kind, category, incident_id, severity, created_at)
      VALUES (${school}, 'synthetic-fingerprint-1', 'message', 'synthetic-category', 'synthetic-safety-1', 'medium', ${createdAt});`;
  });
}

async function verifyOperationalTables(sql) {
  const notification = (await sql`SELECT notification_key, read_at FROM fam_notification_reads WHERE user_id = ${target};`)[0];
  const suspension = (await sql`SELECT target_id, school_id, status, expires_at FROM fam_account_suspensions WHERE target_id = ${target};`)[0];
  const openSuspension = (await sql`SELECT suspension_id, school_id FROM fam_account_suspension_open WHERE target_id = ${target};`)[0];
  const deletion = (await sql`SELECT request_id, school_id, status FROM fam_account_deletion_requests WHERE target_id = ${target};`)[0];
  const openDeletion = (await sql`SELECT request_id, school_id FROM fam_account_deletion_open WHERE target_id = ${target};`)[0];
  const role = (await sql`SELECT request_id, school_id, requested_role, status FROM fam_school_role_requests WHERE user_id = ${target};`)[0];
  const roleAudit = (await sql`SELECT action, status FROM fam_school_role_request_audit WHERE request_id = 'synthetic-role-1';`)[0];
  const adminAudit = (await sql`SELECT action, previous_role FROM fam_school_admin_audit WHERE event_id = 'synthetic-admin-audit-1';`)[0];
  const safety = (await sql`SELECT category, severity FROM fam_safety_incidents WHERE school_id = ${school};`)[0];

  assert.equal(notification.length, 1);
  assert.equal(suspension.length, 1);
  assert.equal(openSuspension.length, 1);
  assert.equal(deletion.length, 1);
  assert.equal(openDeletion.length, 1);
  assert.equal(role.length, 1);
  assert.equal(roleAudit.length, 1);
  assert.equal(adminAudit.length, 1);
  assert.equal(safety.length, 1);
  assert.equal(suspension[0].school_id, school);
  assert.equal(deletion[0].school_id, school);
  assert.equal(role[0].school_id, school);
  assert.equal(roleAudit[0].action, 'submitted');
  assert.equal(adminAudit[0].action, 'revoke_role');
  assert.equal(safety[0].category, 'synthetic-category');
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
    notifications: [{ notification_id: 'synthetic-notification-1', user_id: target, school_id: school, kind: 'message', read: false, created_at: created }],
    suspensions: [{ suspension_id: 'synthetic-suspension-1', user_id: target, school_id: school, active: true, reason_code: 'synthetic-rule', expires_at: expires }],
    deletion_requests: [{ request_id: 'synthetic-deletion-1', user_id: target, school_id: school, status: 'pending', created_at: created }],
    role_requests: [{ request_id: 'synthetic-role-1', user_id: target, school_id: school, role: 'council_member', status: 'pending', created_at: created }],
    admin_audit: [{ audit_id: 'synthetic-admin-audit-1', school_id: school, actor_id: actor, action: 'revoke_role', entity_id: target, created_at: created }],
    safety_incidents: [{ incident_id: 'synthetic-safety-1', school_id: school, actor_id: target, category: 'synthetic-category', level: 'medium', created_at: created }],
  };
  const envelope = encodeSyntheticOperationalEnvelope(operationalSnapshot);
  assert.equal(envelope.ok, true);
  const decoded = decodeSyntheticOperationalEnvelope(envelope.bytes, envelope.sha256);
  assert.equal(decoded.ok, true);

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

  await seedOperationalTables(sql);
  await verifyOperationalTables(sql);

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
  assert.equal(notificationAfterRollback.length, 1);
  assert.equal(notificationAfterRollback[0].notification_key, 'synthetic:notification:1');

  console.log('YDB_SYNTHETIC_OPERATIONAL_RESTORE_PASS: notifications, suspensions, deletion/role requests, audits and safety incidents restored atomically');
} finally {
  await driver.close();
}
