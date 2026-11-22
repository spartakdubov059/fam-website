export const REQUIRED_RU_TABLES = Object.freeze([
  'fam_account_deletion_jobs', 'fam_account_deletion_open', 'fam_account_deletion_requests',
  'fam_account_suspension_audit', 'fam_account_suspension_open', 'fam_account_suspensions',
  'fam_agent_daily_digest_tasks', 'fam_agent_daily_reports', 'fam_agent_ideas',
  'fam_agent_school_daily_reports', 'fam_agent_task_events', 'fam_agent_tasks',
  'fam_avatar_reviews', 'fam_event_occupancy', 'fam_event_registrations', 'fam_favorites',
  'fam_idea_images', 'fam_ideas', 'fam_initial_school_admin_bootstrap', 'fam_listings', 'fam_messages', 'fam_notification_reads',
  'fam_pending_media', 'fam_pending_messages', 'fam_profile_requests', 'fam_safety_incidents',
  'fam_school_admin_audit', 'fam_school_content_audit', 'fam_school_announcements',
  'fam_school_poll_votes', 'fam_school_polls', 'fam_school_role_request_audit',
  'fam_school_role_requests', 'fam_role_email_verifications', 'fam_site_error_counts', 'fam_site_error_digest_tasks',
  'fam_step_up_email_challenges', 'fam_submission_quotas', 'fam_user_profiles',
]);

export function createYdbSchemaHealthCheck(sql, { tables = REQUIRED_RU_TABLES, identifier, fragment, join } = {}) {
  if (typeof sql !== 'function' || !Array.isArray(tables) || !tables.length
      || typeof identifier !== 'function'
      || typeof fragment !== 'function' || typeof join !== 'function'
      || tables.some(name => typeof name !== 'string' || !/^fam_[a-z0-9_]+$/.test(name))
      || new Set(tables).size !== tables.length) throw new TypeError('invalid RU schema health configuration');
  return async function checkYdbSchemaHealth() {
    const statements = tables.map(name => fragment`SELECT * FROM ${identifier(name)} LIMIT 0`);
    const resultSets = await sql`${join(statements, ';')}`;
    if (!Array.isArray(resultSets) || resultSets.length !== tables.length) throw new Error('invalid RU schema probe result');
    return Object.freeze({ ok: true, tables_checked: tables.length, content_read: false, write_permissions_checked: false });
  };
}
