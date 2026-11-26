import { createHash } from 'node:crypto';

const SYNTHETIC_ID = /^synthetic-[a-z0-9-]{3,100}$/i;
const TS = /^2026-11-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const sections = Object.freeze({
  notifications: ['notification_id', 'user_id', 'school_id', 'kind', 'read', 'created_at'],
  suspensions: ['suspension_id', 'user_id', 'school_id', 'active', 'reason_code', 'expires_at'],
  deletion_requests: ['request_id', 'user_id', 'school_id', 'status', 'created_at'],
  role_requests: ['request_id', 'user_id', 'school_id', 'role', 'status', 'created_at'],
  admin_audit: ['audit_id', 'school_id', 'actor_id', 'action', 'entity_id', 'created_at'],
  safety_incidents: ['incident_id', 'school_id', 'actor_id', 'category', 'level', 'created_at'],
});

function exact(row, fields) {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length === fields.length
    && fields.every(field => Object.hasOwn(row, field));
}

function validTimestamp(value) {
  return typeof value === 'string' && TS.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateRows(section, rows) {
  if (!Array.isArray(rows) || rows.length > 10000) return false;
  const fields = sections[section];
  const keys = new Set();
  for (const row of rows) {
    if (!exact(row, fields)) return false;
    const key = row[fields[0]];
    if (typeof key !== 'string' || !SYNTHETIC_ID.test(key)) return false;
    if (keys.has(key)) return false;
    keys.add(key);
    if (!Object.entries(row).every(([, value]) => typeof value === 'string' || typeof value === 'boolean')) return false;
    if (Object.hasOwn(row, 'school_id') && (typeof row.school_id !== 'string' || !SYNTHETIC_ID.test(row.school_id))) return false;
    if (Object.hasOwn(row, 'user_id') && (typeof row.user_id !== 'string' || !SYNTHETIC_ID.test(row.user_id))) return false;
    if (Object.hasOwn(row, 'actor_id') && (typeof row.actor_id !== 'string' || !SYNTHETIC_ID.test(row.actor_id))) return false;
    if (Object.hasOwn(row, 'entity_id') && (typeof row.entity_id !== 'string' || !SYNTHETIC_ID.test(row.entity_id))) return false;
    for (const field of ['created_at', 'expires_at']) {
      if (Object.hasOwn(row, field) && !validTimestamp(row[field])) return false;
    }
    if (section === 'notifications') {
      if (typeof row.read !== 'boolean' || !['message', 'listing', 'release', 'deletion', 'role'].includes(row.kind)) return false;
    }
    if (section === 'suspensions') {
      if (typeof row.active !== 'boolean'
          || typeof row.reason_code !== 'string'
          || !SYNTHETIC_ID.test(row.reason_code)) return false;
    }
    if (section === 'deletion_requests') {
      if (!['pending', 'reviewing', 'approved', 'rejected', 'cancelled'].includes(row.status)) return false;
    }
    if (section === 'role_requests') {
      if (!['student', 'council_member', 'school_admin'].includes(row.role)
          || !['pending', 'reviewing', 'approved', 'rejected', 'cancelled'].includes(row.status)) return false;
    }
    if (section === 'admin_audit') {
      if (!['grant_role', 'revoke_role', 'approve_request', 'reject_request', 'issue_suspension', 'lift_suspension'].includes(row.action)) return false;
    }
    if (section === 'safety_incidents') {
      if (!['low', 'medium', 'high', 'critical'].includes(row.level)
          || typeof row.category !== 'string' || !SYNTHETIC_ID.test(row.category)) return false;
    }
  }
  return true;
}

export function verifySyntheticOperationalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || Object.keys(snapshot).length !== 7
      || !Object.hasOwn(snapshot, 'snapshot_id')
      || typeof snapshot.snapshot_id !== 'string'
      || !/^synthetic-[a-z0-9-]{3,64}$/i.test(snapshot.snapshot_id)) {
    return { ok: false, code: 'INVALID_OPERATIONAL_SNAPSHOT', live_cutover_authorized: false };
  }
  const allowed = new Set(['snapshot_id', ...Object.keys(sections)]);
  if (Object.keys(snapshot).some(key => !allowed.has(key))) {
    return { ok: false, code: 'INVALID_OPERATIONAL_SNAPSHOT', live_cutover_authorized: false };
  }
  for (const section of Object.keys(sections)) {
    if (!Object.hasOwn(snapshot, section) || !validateRows(section, snapshot[section])) {
      return { ok: false, code: 'INVALID_OPERATIONAL_SECTION', table: section, live_cutover_authorized: false };
    }
  }
  const schoolIds = new Set();
  for (const section of Object.keys(sections)) {
    for (const row of snapshot[section]) {
      if (Object.hasOwn(row, 'school_id')) schoolIds.add(row.school_id);
    }
  }
  if (schoolIds.size !== 1) {
    return { ok: false, code: 'OPERATIONAL_SCHOOL_SCOPE_MISMATCH', live_cutover_authorized: false };
  }
  return { ok: true, code: 'SYNTHETIC_OPERATIONAL_SNAPSHOT_PASS', live_cutover_authorized: false };
}

function canonicalRows(section,rows) {
  const fields=sections[section];
  return rows.map(row=>Object.fromEntries(fields.map(field=>[field,row[field]])))
    .sort((a,b)=>a[fields[0]]<b[fields[0]]?-1:a[fields[0]]>b[fields[0]]?1:0);
}

export function compareSyntheticOperationalSnapshots(source, target, restored) {
  for (const [side, snapshot] of [['source', source], ['target', target], ['restored', restored]]) {
    const valid = verifySyntheticOperationalSnapshot(snapshot);
    if (!valid.ok) return { ...valid, stage: `${side}_operational` };
  }
  if (source.snapshot_id !== target.snapshot_id || source.snapshot_id !== restored.snapshot_id) {
    return { ok: false, code: 'SNAPSHOT_ID_MISMATCH', stage: 'operational', live_cutover_authorized: false };
  }
  for (const section of Object.keys(sections)) {
    const canonical = rows => JSON.stringify(canonicalRows(section, rows));
    if (canonical(source[section]) !== canonical(target[section])
        || canonical(source[section]) !== canonical(restored[section])) {
      return { ok: false, code: 'OPERATIONAL_STATE_MISMATCH', table: section, live_cutover_authorized: false };
    }
  }
  const canonicalSource={snapshot_id:source.snapshot_id,...Object.fromEntries(Object.keys(sections).map(section=>[section,canonicalRows(section,source[section])]))};
  const digest=createHash('sha256').update(JSON.stringify(canonicalSource)).digest('hex');
  return {
    ok: true,
    code: 'SYNTHETIC_OPERATIONAL_RECONCILIATION_PASS',
    snapshot_id: source.snapshot_id,
    inventory_digest: digest,
    live_cutover_authorized: false,
  };
}
