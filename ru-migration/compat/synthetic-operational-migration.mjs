import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const key = row[Object.keys(row)[0]];
    if (!SYNTHETIC_ID.test(key) && !UUID.test(key)) return false;
    if (keys.has(key)) return false;
    keys.add(key);
    if (!Object.entries(row).every(([, value]) => typeof value === 'string' || typeof value === 'boolean')) return false;
    if (Object.hasOwn(row, 'school_id') && !SYNTHETIC_ID.test(row.school_id) && !UUID.test(row.school_id)) return false;
    if (Object.hasOwn(row, 'user_id') && !SYNTHETIC_ID.test(row.user_id) && !UUID.test(row.user_id)) return false;
    if (Object.hasOwn(row, 'actor_id') && !SYNTHETIC_ID.test(row.actor_id) && !UUID.test(row.actor_id)) return false;
    if (Object.hasOwn(row, 'entity_id') && typeof row.entity_id !== 'string') return false;
    for (const field of ['created_at', 'expires_at']) {
      if (Object.hasOwn(row, field) && !validTimestamp(row[field])) return false;
    }
  }
  return true;
}

export function verifySyntheticOperationalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || (Object.keys(snapshot).length !== 7 && Object.keys(snapshot).length !== 8)
      || !Object.hasOwn(snapshot, 'snapshot_id')
      || typeof snapshot.snapshot_id !== 'string'
      || !/^synthetic-[a-z0-9-]{3,64}$/i.test(snapshot.snapshot_id)) {
    return { ok: false, code: 'INVALID_OPERATIONAL_SNAPSHOT', live_cutover_authorized: false };
  }
  const allowed = new Set(['snapshot_id', 'inventory_digest', ...Object.keys(sections)]);
  if (Object.keys(snapshot).some(key => !allowed.has(key))) {
    return { ok: false, code: 'INVALID_OPERATIONAL_SNAPSHOT', live_cutover_authorized: false };
  }
  for (const section of Object.keys(sections)) {
    if (!Object.hasOwn(snapshot, section) || !validateRows(section, snapshot[section])) {
      return { ok: false, code: 'INVALID_OPERATIONAL_SECTION', table: section, live_cutover_authorized: false };
    }
  }
  if (Object.hasOwn(snapshot, 'inventory_digest') && typeof snapshot.inventory_digest !== 'string') {
    return { ok: false, code: 'INVALID_OPERATIONAL_DIGEST', live_cutover_authorized: false };
  }
  return { ok: true, code: 'SYNTHETIC_OPERATIONAL_SNAPSHOT_PASS', live_cutover_authorized: false };
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
    const canonical = rows => JSON.stringify(rows.slice().sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (canonical(source[section]) !== canonical(target[section])
        || canonical(source[section]) !== canonical(restored[section])) {
      return { ok: false, code: 'OPERATIONAL_STATE_MISMATCH', table: section, live_cutover_authorized: false };
    }
  }
  const digest = createHash('sha256').update(JSON.stringify({
    snapshot_id: source.snapshot_id,
    notifications: source.notifications,
    suspensions: source.suspensions,
    deletion_requests: source.deletion_requests,
    role_requests: source.role_requests,
    admin_audit: source.admin_audit,
    safety_incidents: source.safety_incidents,
  })).digest('hex');
  return {
    ok: true,
    code: 'SYNTHETIC_OPERATIONAL_RECONCILIATION_PASS',
    snapshot_id: source.snapshot_id,
    inventory_digest: digest,
    live_cutover_authorized: false,
  };
}
