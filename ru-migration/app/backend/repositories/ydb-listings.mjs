Warning: truncated output (original token count: 41262)
Total output lines: 2386

import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function consumeSubmissionQuota(tx, userId, action, limit, windowMs = 3_600_000) {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const rows = await tx`SELECT submission_count FROM fam_submission_quotas
    WHERE user_id = ${userId} AND action = ${action} AND window_start = ${windowStart} LIMIT 1;`;
  const current = Number(rows?.[0]?.[0]?.submission_count ?? 0);
  if (!Number.isSafeInteger(current) || current < 0 || current >= limit) {
    return false;
  }
  await tx`UPSERT INTO fam_submission_quotas (user_id, action, window_start, submission_count)
    VALUES (${userId}, ${action}, ${windowStart}, Unwrap(CAST(${current + 1} AS Uint32)));`;
  return true;
}

async function consumeRollingSubmissionQuota(tx, userId, action, limit) {
  const rows = await tx`SELECT submission_count FROM fam_submission_quotas
    WHERE user_id = ${userId} AND action = ${action}
      AND window_start > CurrentUtcTimestamp() - Interval('PT1M')
    ORDER BY window_start DESC LIMIT 1;`;
  const current = Number(rows?.[0]?.[0]?.submission_count ?? 0);
  if (!Number.isSafeInteger(current) || current < 0 || current >= limit) return false;
  await tx`DELETE FROM fam_submission_quotas WHERE user_id = ${userId} AND action = ${action};`;
  await tx`UPSERT INTO fam_submission_quotas (user_id, action, window_start, submission_count)
    VALUES (${userId}, ${action}, CurrentUtcTimestamp(), Unwrap(CAST(${current + 1} AS Uint32)));`;
  return true;
}

const isIsoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const isQuarterHourSlot = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value)) return false;
  const date = new Date(`${value}:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
};

// The caller owns the connection and injects a @ydbjs/query tagged client.
// Dynamic values are bound by the SDK, never concatenated into YQL.
export function createYdbListingsRepository(sql) {
  if (typeof sql !== 'function') throw new TypeError('YDB query client is required');
  return {
    async bootstrapInitialSchoolAdmin({ issuer, subject, userId, schoolId, firstName, lastName }) {
      if (issuer !== 'https://login.yandex.ru' || typeof subject !== 'string' || !/^\d{1,32}$/.test(subject)
          || !UUID.test(userId) || !['lyceum_3', 'gymnasium_4'].includes(schoolId)
          || typeof firstName !== 'string' || firstName.trim() !== firstName || firstName.length < 1 || firstName.length > 80
          || typeof lastName !== 'string' || lastName.trim() !== lastName || lastName.length < 1 || lastName.length > 80) {
        throw new TypeError('invalid initial school admin bootstrap');
      }
      return sql.begin(async tx => {
        const markerRows = await tx`SELECT school_id FROM fam_initial_school_admin_bootstrap WHERE school_id = ${schoolId} LIMIT 1;`;
        if (markerRows?.[0]?.length) return { ok: false, code: 'already_bootstrapped' };
        const identityRows = await tx`SELECT user_id FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        if (identityRows?.[0]?.length) return { ok: false, code: 'identity_exists' };
        const adminRows = await tx`SELECT user_id FROM fam_user_profiles
          WHERE school_id = ${schoolId} AND role = 'school_admin' AND active = true LIMIT 1;`;
        if (adminRows?.[0]?.length) return { ok: false, code: 'admin_exists' };
        await tx`INSERT INTO fam_user_profiles
          (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name, city, avatar_url)
          VALUES (${issuer}, ${subject}, ${userId}, ${schoolId}, 'school_admin', true, ${firstName}, ${lastName}, '', '', '');`;
        await tx`INSERT INTO fam_initial_school_admin_bootstrap (school_id, user_id, provisioned_at)
          VALUES (${schoolId}, ${userId}, CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_school_admin_audit
          (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${userId}, ${userId}, 'initial_admin_bootstrap', 'none', CurrentUtcTimestamp());`;
        return { ok: true, user_id: userId };
      });
    },
    async updateOwnProfileIdentity(issuer, subject, fields) {
      if (!issuer || !subject || !fields || typeof fields.first_name !== 'string' || typeof fields.last_name !== 'string'
          || typeof fields.class_name !== 'string' || !['student', 'school_staff', 'parent'].includes(fields.person_type)
          || typeof fields.staff_position !== 'string') {
        throw new TypeError('invalid profile identity update');
      }
      return sql.begin(async tx => {
        const rows = await tx`SELECT user_id, active, person_type, staff_position, staff_verification_status
          FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (!current?.active || !current.user_id) return null;
        const staffPosition = fields.person_type === 'school_staff' ? fields.staff_position : '';
        const verificationStatus = fields.person_type !== 'school_staff' ? 'not_required'
          : current.person_type !== 'school_staff' || current.staff_position !== staffPosition ? 'pending'
            : current.staff_verification_status;
        const className = fields.person_type === 'student' ? fields.class_name : '';
        await tx`UPDATE fam_user_profiles SET first_name = ${fields.first_name}, last_name = ${fields.last_name},
            class_name = ${className}, person_type = ${fields.person_type}, staff_position = ${staffPosition},
            staff_verification_status = ${verificationStatus}
          WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${current.user_id} AND active = true;`;
        const updated = await tx`SELECT user_id AS id, school_id, role, first_name, last_name, class_name, city, avatar_url,
            person_type, staff_position, staff_verification_status
          FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        return updated?.[0]?.[0] ?? null;
      });
    },

    async createSchoolRoleRequest({ issuer, subject, requested_role }) {
      if (!issuer || !subject || !['council_member', 'school_admin'].includes(requested_role)) throw new TypeError('invalid school role request');
      const requestId = randomUUID();
      return sql.begin(async tx => {
        const profiles = await tx`SELECT user_id, school_id, role, active FROM fam_user_profiles
          WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const profile = profiles?.[0]?.[0];
        if (!profile || !profile.active || profile.role !== 'student' || !profile.school_id) return { ok: false, code: 'student_profile_required' };
        const requests = await tx`SELECT request_id, status FROM fam_school_role_requests
          WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const prior = requests?.[0]?.[0];
        if (prior && ['pending', 'reviewing'].includes(prior.status)) return { ok: true, status: prior.status, request_id: prior.request_id, already_exists: true };
        await tx`UPSERT INTO fam_school_role_requests
          (issuer, subject, request_id, user_id, school_id, requested_role, status, review_started_by, review_started_at, reviewed_by, reviewed_at, review_note, created_at)
          VALUES (${issuer}, ${subject}, ${requestId}, ${profile.user_id}, ${profile.school_id}, ${requested_role}, 'pending', NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_school_role_request_audit
          (event_id, request_id, school_id, actor_id, requested_role, action, status, created_at)
          VALUES (${randomUUID()}, ${requestId}, ${profile.school_id}, ${profile.user_id}, ${requested_role}, 'submitted', 'pending', CurrentUtcTimestamp());`;
        return { ok: true, status: 'pending', request_id: requestId, already_exists: false };
      });
    },

    async getSchoolRoleRequest(issuer, subject) {
      if (!issuer || !subject) throw new TypeError('invalid role request identity');
      const statement = sql`SELECT request_id, school_id, requested_role, status, created_at, review_started_at, reviewed_at, review_note
        FROM fam_school_role_requests WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0]?.[0] ?? null;
    },

    async listPendingSchoolRoleRequests(schoolId) {
      if (!schoolId) throw new TypeError('invalid role request school');
      const statement = sql`SELECT r.request_id AS request_id, r.user_id AS user_id,
          r.requested_role AS requested_role, r.status AS status, r.created_at AS created_at,
          r.review_started_at AS review_started_at, r.review_started_by AS review_started_by,
          p.first_name AS first_name, p.last_name AS last_name, p.class_name AS class_name
        FROM fam_school_role_requests AS r
        INNER JOIN fam_user_profiles AS p ON p.user_id = r.user_id AND p.school_id = r.school_id
        WHERE r.school_id = ${schoolId} AND r.status IN ('pending', 'reviewing')
        ORDER BY r.created_at ASC LIMIT 50;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async startSchoolRoleRequestReview(requestId, schoolId, reviewerId) {
      if (!requestId || !schoolId || !reviewerId) throw new TypeError('invalid role request review');
      return sql.begin(async tx => {
        const reviewerRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewerRows?.[0]?.[0];
        if (!reviewer || !reviewer.active || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId) return false;
        const requestRows = await tx`SELECT issuer, subject, user_id, school_id, requested_role, status FROM fam_school_role_requests WHERE request_id = ${requestId} LIMIT 1;`;
        const request = requestRows?.[0]?.[0];
        if (!request || request.school_id !== schoolId || request.user_id === reviewerId || request.status !== 'pending') return false;
        await tx`UPDATE fam_school_role_requests SET status = 'reviewing', review_started_by = ${reviewerId}, review_started_at = CurrentUtcTimestamp()
          WHERE issuer = ${request.issuer} AND subject = ${request.subject} AND request_id = ${requestId} AND status = 'pending';`;
        await tx`INSERT INTO fam_school_role_request_audit
          (event_id, request_id, school_id, actor_id, requested_role, action, status, created_at)
          VALUES (${randomUUID()}, ${requestId}, ${schoolId}, ${reviewerId}, ${request.requested_role}, 'review_started', 'reviewing', CurrentUtcTimestamp());`;
        const result = await tx`SELECT status, review_started_by FROM fam_school_role_requests WHERE issuer = ${request.issuer} AND subject = ${request.subject} LIMIT 1;`;
        const row = result?.[0]?.[0];
        return row?.status === 'reviewing' && row.review_started_by === reviewerId;
      });
    },

    async reviewSchoolRoleRequest(requestId, schoolId, reviewerId, decision, note = '') {
      if (!requestId || !schoolId || !reviewerId || !['approve', 'reject'].includes(decision) || typeof note !== 'string' || note.length > 240) throw new TypeError('invalid role request decision');
      return sql.begin(async tx => {
        const reviewerRows = await tx`SELECT school_id,…35262 tokens truncated…, NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        return { created: true, status: 'queued' };
      });
    },

    async claimSiteErrorDigestTask(workerId) {
      if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 80) {
        throw new TypeError('invalid site error digest claim');
      }
      return sql.begin(async tx => {
        const candidates = await tx`SELECT digest_slot, status, attempt_count, max_attempts,
            CASE WHEN available_at <= CurrentUtcTimestamp() THEN true ELSE false END AS available,
            CASE WHEN lease_expires_at IS NULL OR lease_expires_at <= CurrentUtcTimestamp() THEN true ELSE false END AS lease_expired
          FROM fam_site_error_digest_tasks WHERE attempt_count < max_attempts
            AND ((status IN ('queued', 'failed') AND available_at <= CurrentUtcTimestamp())
              OR (status = 'claimed' AND lease_expires_at <= CurrentUtcTimestamp()))
          ORDER BY digest_slot ASC LIMIT 1;`;
        const task = candidates?.[0]?.[0];
        if (!task) return null;
        if (!isQuarterHourSlot(task.digest_slot)) throw new Error('invalid stored site error digest slot');
        const due = task.available === true && ['queued', 'failed'].includes(task.status)
          || task.status === 'claimed' && task.lease_expired === true;
        if (!due) return null;
        const claimToken = randomUUID();
        await tx`UPDATE fam_site_error_digest_tasks SET status = Unwrap(CAST('claimed' AS Utf8)),
            attempt_count = Unwrap(CAST(Unwrap(CAST(attempt_count AS Uint32)) + Unwrap(CAST(1 AS Uint32)) AS Uint32)),
            claimed_by = ${workerId}, claim_token = ${claimToken}, lease_expires_at = CurrentUtcTimestamp() + Interval('PT2M'),
            last_error_code = CAST(NULL AS Utf8?), updated_at = CurrentUtcTimestamp()
          WHERE digest_slot = ${task.digest_slot};`;
        return { digest_slot: task.digest_slot, claim_token: claimToken };
      });
    },

    async getSiteErrorDigestMetrics() {
      const statement = sql`SELECT event_code, page_area, event_count,
          CASE WHEN hour_bucket >= CurrentUtcTimestamp() - Interval('PT1H') THEN true ELSE false END AS last_hour
        FROM fam_site_error_counts WHERE hour_bucket >= CurrentUtcTimestamp() - Interval('PT24H')
        ORDER BY hour_bucket DESC LIMIT 1000;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const rows = (await statement)?.[0] ?? [];
      let total = 0; let lastHour = 0;
      const grouped = new Map();
      for (const row of rows) {
        const occurrences = Number(row.event_count);
        if (!Number.isSafeInteger(occurrences) || occurrences < 0) throw new Error('invalid site error counter');
        total += occurrences;
        if (row.last_hour === true) lastHour += occurrences;
        const key = `${row.event_code}/${row.page_area}`;
        const prior = grouped.get(key);
        grouped.set(key, { event_code: row.event_code, page_area: row.page_area, occurrences: (prior?.occurrences ?? 0) + occurrences });
      }
      const events = [...grouped.values()].sort((a, b) => b.occurrences - a.occurrences
        || a.event_code.localeCompare(b.event_code) || a.page_area.localeCompare(b.page_area)).slice(0, 6);
      return { total_events_24h: total, events_last_hour: lastHour, events };
    },

    async getLatestSiteErrorDigest() {
      const statement = sql`SELECT digest_slot, generated_at, metrics_json, summary FROM fam_site_error_digest_tasks
        WHERE status = 'completed' ORDER BY digest_slot DESC LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const row = (await statement)?.[0]?.[0];
      if (!row || !isQuarterHourSlot(row.digest_slot) || typeof row.summary !== 'string' || row.summary.length > 1000) return null;
      let metrics;
      try { metrics = JSON.parse(row.metrics_json); } catch { return null; }
      if (!Number.isSafeInteger(metrics?.total_events_24h) || metrics.total_events_24h < 0
          || !Number.isSafeInteger(metrics?.events_last_hour) || metrics.events_last_hour < 0
          || !Array.isArray(metrics.events) || metrics.events.length > 6
          || metrics.events.some(event => typeof event.event_code !== 'string' || typeof event.page_area !== 'string'
            || !Number.isSafeInteger(event.occurrences) || event.occurrences < 0)) return null;
      return { digest_slot: row.digest_slot, generated_at: row.generated_at, summary: row.summary, metrics };
    },

    async completeSiteErrorDigestTask({ digestSlot, claimToken, metrics, summary }) {
      if (!isQuarterHourSlot(digestSlot) || !UUID.test(claimToken || '') || !metrics
          || !Number.isSafeInteger(metrics.total_events_24h) || metrics.total_events_24h < 0
          || !Number.isSafeInteger(metrics.events_last_hour) || metrics.events_last_hour < 0
          || !Array.isArray(metrics.events) || metrics.events.length > 6
          || typeof summary !== 'string' || summary.length > 1000) throw new TypeError('invalid site error digest result');
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claim_token, lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_site_error_digest_tasks WHERE digest_slot = ${digestSlot} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.status !== 'claimed' || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_site_error_digest_tasks SET status = Unwrap(CAST('completed' AS Utf8)), generated_at = CurrentUtcTimestamp(),
            metrics_json = ${JSON.stringify(metrics)}, summary = ${summary}, claimed_by = CAST(NULL AS Utf8?),
            claim_token = CAST(NULL AS Utf8?), lease_expires_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp()
          WHERE digest_slot = ${digestSlot};`;
        return true;
      });
    },

    async retrySiteErrorDigestTask({ digestSlot, claimToken, errorCode = 'digest_failed' }) {
      if (!isQuarterHourSlot(digestSlot) || !UUID.test(claimToken || '')
          || !['digest_failed', 'invalid_metrics'].includes(errorCode)) throw new TypeError('invalid site error digest retry');
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claim_token, lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_site_error_digest_tasks WHERE digest_slot = ${digestSlot} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.status !== 'claimed' || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_site_error_digest_tasks SET status = Unwrap(CAST('failed' AS Utf8)),
            available_at = CurrentUtcTimestamp() + Interval('PT5M'), last_error_code = ${errorCode},
            claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
            lease_expires_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp()
          WHERE digest_slot = ${digestSlot};`;
        return true;
      });
    },

    async recordSiteError({ eventCode, pageArea, occurredAt = new Date() }) {
      const bucket = new Date(occurredAt);
      if (!Number.isFinite(bucket.getTime())) throw new TypeError('invalid site error timestamp');
      bucket.setUTCMinutes(0, 0, 0);
      const hourBucket = bucket.toISOString();
      return sql.begin(async tx => {
        const priorRows = await tx`SELECT event_count FROM fam_site_error_counts
          WHERE hour_bucket = Unwrap(CAST(${hourBucket} AS Timestamp)) AND event_code = ${eventCode} AND page_area = ${pageArea} LIMIT 1;`;
        const count = Math.min(1000, Number(priorRows?.[0]?.[0]?.event_count ?? 0) + 1);
        await tx`UPSERT INTO fam_site_error_counts (hour_bucket, event_code, page_area, event_count, created_at, updated_at)
          VALUES (Unwrap(CAST(${hourBucket} AS Timestamp)), ${eventCode}, ${pageArea}, Unwrap(CAST(${count} AS Uint32)),
            CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        return count;
      });
    },

    async listSiteErrorAlerts() {
      const result = await sql`SELECT hour_bucket, event_code, page_area, event_count
        FROM fam_site_error_counts
        WHERE hour_bucket >= CurrentUtcTimestamp() - Interval('PT24H')
          AND ((event_code = 'database_request_failed' AND event_count >= 3)
            OR (event_code = 'auth_backend_failed' AND event_count >= 5)
            OR (event_code IN ('js_runtime', 'unhandled_rejection') AND event_count >= 10)
            OR (event_code IN ('listings_load_failed', 'notifications_load_failed') AND event_count >= 8))
        ORDER BY hour_bucket DESC, event_count DESC LIMIT 20;`;
      return (result?.[0] ?? []).map(row => ({ ...row,
        severity: ['database_request_failed', 'auth_backend_failed'].includes(row.event_code) ? 'critical' : 'warning',
      }));
    },

    async getSchoolAgentDashboard(schoolId) {
      if (!schoolId) throw new TypeError('invalid school agent dashboard school');
      const [reports, ideas] = await Promise.all([
        sql`SELECT report_date, generated_at, summary, metrics_json FROM fam_agent_school_daily_reports WHERE school_id = ${schoolId} ORDER BY report_date DESC LIMIT 1;`,
        sql`SELECT id, report_date, title, summary, benefit, complexity, risk, evidence_kind, evidence_summary, proposed_by, status
          FROM fam_agent_ideas WHERE school_id = ${schoolId} AND status = 'pending' ORDER BY created_at ASC LIMIT 20;`,
      ]);
      const report = reports?.[0]?.[0] ?? null;
      let metrics = null;
      try { metrics = report?.metrics_json ? JSON.parse(report.metrics_json) : null; } catch { metrics = null; }
      return { report: report ? { report_date: report.report_date, generated_at: report.generated_at, summary: report.summary, metrics } : null,
        ideas: ideas?.[0] ?? [] };
    },

    async reviewSchoolAgentIdea({ id, schoolId, reviewerId, decision }) {
      if (!id || !schoolId || !reviewerId || !['approved', 'rejected'].includes(decision)) throw new TypeError('invalid school agent idea decision');
      return sql.begin(async tx => {
        const actorRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const actor = actorRows?.[0]?.[0];
        if (!actor || actor.active !== true || actor.role !== 'school_admin' || actor.school_id !== schoolId) return false;
        const rows = await tx`SELECT status FROM fam_agent_ideas WHERE id = ${id} AND school_id = ${schoolId} LIMIT 1;`;
        if (rows?.[0]?.[0]?.status !== 'pending') return false;
        await tx`UPDATE fam_agent_ideas SET status = ${decision}, reviewed_by = ${reviewerId}, reviewed_at = CurrentUtcTimestamp()
          WHERE id = ${id} AND school_id = ${schoolId} AND status = 'pending';`;
        return true;
      });
    },

    async listNotificationReadStates(userId) {
      if (!userId) throw new TypeError('invalid notification state owner');
      const result = await sql`SELECT notification_key, read_at FROM fam_notification_reads
        WHERE user_id = ${userId} ORDER BY notification_key LIMIT 10001;`;
      return result?.[0] ?? [];
    },

    async saveNotificationReadStates(userId, notificationKeys) {
      if (!userId || !Array.isArray(notificationKeys) || notificationKeys.length > 100
          || notificationKeys.some(key => typeof key !== 'string' || key.length < 1 || key.length > 220 || /[\u0000-\u001f\u007f]/u.test(key))) {
        throw new TypeError('invalid notification read states');
      }
      const keys = [...new Set(notificationKeys)];
      return sql.begin(async tx => {
        for (const key of keys) {
          await tx`UPSERT INTO fam_notification_reads (user_id, notification_key, read_at)
            VALUES (${userId}, ${key}, CurrentUtcTimestamp());`;
        }
        return true;
      });
    },
  };
}
