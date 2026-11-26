import { createHash } from 'node:crypto';

export const RU_MIGRATION_TABLES = Object.freeze([
  'fam_account_deletion_jobs',
  'fam_account_deletion_open',
  'fam_account_deletion_requests',
  'fam_account_suspension_audit',
  'fam_account_suspension_open',
  'fam_account_suspensions',
  'fam_agent_daily_digest_tasks',
  'fam_agent_daily_reports',
  'fam_agent_ideas',
  'fam_agent_inspector_signals',
  'fam_agent_school_daily_reports',
  'fam_agent_task_events',
  'fam_agent_tasks',
  'fam_avatar_reviews',
  'fam_event_occupancy',
  'fam_event_registrations',
  'fam_favorites',
  'fam_idea_images',
  'fam_ideas',
  'fam_initial_school_admin_bootstrap',
  'fam_listings',
  'fam_messages',
  'fam_notification_reads',
  'fam_pending_media',
  'fam_pending_messages',
  'fam_profile_requests',
  'fam_role_email_verifications',
  'fam_safety_incidents',
  'fam_school_admin_audit',
  'fam_school_announcements',
  'fam_school_content_audit',
  'fam_school_poll_votes',
  'fam_school_polls',
  'fam_school_role_request_audit',
  'fam_school_role_requests',
  'fam_site_error_counts',
  'fam_site_error_digest_tasks',
  'fam_step_up_email_challenges',
  'fam_submission_quotas',
  'fam_user_profiles',
]);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function prepareSyntheticBatchPlan(snapshot, { batchSize = 100 } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || typeof snapshot.snapshot_id !== 'string'
      || !/^synthetic-[a-z0-9-]{3,64}$/i.test(snapshot.snapshot_id)
      || !exact(snapshot, ['snapshot_id', 'tables'])
      || !snapshot.tables || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) {
    return { ok: false, code: 'INVALID_SYNTHETIC_BATCH', live_cutover_authorized: false };
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    return { ok: false, code: 'INVALID_BATCH_SIZE', live_cutover_authorized: false };
  }
  const names = Object.keys(snapshot.tables);
  if (!names.length || names.some(name => !RU_MIGRATION_TABLES.includes(name))
      || names.some(name => !Array.isArray(snapshot.tables[name]))
      || names.some(name => snapshot.tables[name].length > 10_000)) {
    return { ok: false, code: 'UNSUPPORTED_MIGRATION_TABLE', live_cutover_authorized: false };
  }
  const batches = [];
  for (const table of names.sort()) {
    const rows = snapshot.tables[table];
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const chunk = rows.slice(offset, offset + batchSize);
      batches.push(Object.freeze({
        table,
        offset,
        count: chunk.length,
        digest: hash(JSON.stringify(chunk)),
      }));
    }
  }
  const canonical = JSON.stringify({ snapshot_id: snapshot.snapshot_id, table_count: names.length, batches });
  return {
    ok: true,
    code: 'SYNTHETIC_BATCH_PLAN_READY',
    snapshot_id: snapshot.snapshot_id,
    table_count: names.length,
    batch_count: batches.length,
    batches: Object.freeze(batches),
    plan_digest: hash(canonical),
    live_cutover_authorized: false,
  };
}

export function verifySyntheticBatchRecovery(plan, completedBatches, interruptedIndex) {
  if (!plan || plan.ok !== true || !Array.isArray(completedBatches)
      || !Number.isSafeInteger(interruptedIndex) || interruptedIndex < -1
      || interruptedIndex >= plan.batch_count) {
    return { ok: false, code: 'INVALID_BATCH_RECOVERY', live_cutover_authorized: false };
  }
  const completed = [];
  for (const item of completedBatches) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || !Object.hasOwn(item, 'table')
        || !Object.hasOwn(item, 'offset')
        || !Object.hasOwn(item, 'digest')
        || typeof item.table !== 'string'
        || !Number.isSafeInteger(item.offset)
        || !/^([a-f0-9]{64})$/.test(item.digest)) {
      return { ok: false, code: 'INVALID_COMPLETED_BATCH', live_cutover_authorized: false };
    }
    const expected = plan.batches.find(batch =>
      batch.table === item.table && batch.offset === item.offset);
    if (!expected || item.digest !== expected.digest) {
      return { ok: false, code: 'BATCH_DIGEST_MISMATCH', live_cutover_authorized: false };
    }
    completed.push(`${item.table}:${item.offset}`);
  }
  const remaining = plan.batches
    .filter(batch => !completed.includes(`${batch.table}:${batch.offset}`))
    .map(batch => ({ table: batch.table, offset: batch.offset, digest: batch.digest }));
  return {
    ok: true,
    code: 'SYNTHETIC_BATCH_RECOVERY_READY',
    interrupted_index: interruptedIndex,
    completed: completed.length,
    remaining,
    live_cutover_authorized: false,
  };
}
