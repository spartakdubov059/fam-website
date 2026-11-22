Warning: truncated output (original token count: 43096)
Total output lines: 2479

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Uint32, Uint64 } from '@ydbjs/value/primitive';

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

    async isRoleEmailVerified({ issuer, subject, emailDigest }) {
      if (!issuer || !subject || !/^[a-f0-9]{64}$/i.test(emailDigest || '')) throw new TypeError('invalid role email verification lookup');
      const statement = sql`SELECT email_digest, verified_seconds FROM fam_role_email_verifications
        WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const row = (await statement)?.[0]?.[0];
      return row?.email_digest === emailDigest && Number(row.verified_seconds) > 0;
    },

    async startRoleEmailVerification({ issuer, subject, userId, emailDigest, codeDigest, currentSeconds, expiresSeconds }) {
      if (!issuer || !subject || !userId || !/^[a-f0-9]{64}$/i.test(emailDigest || '')
          || !/^[a-f0-9]{64}$/i.test(codeDigest || '') || !Number.isSafeInteger(currentSeconds)
          || !Number.isSafeInteger(expiresSeconds) || expiresSeconds <= currentSeconds) throw new TypeError('invalid role email verification challenge');
      return sql.begin(async tx => {
        const rows = await tx`SELECT email_digest, window_started_seconds, send_count, sent_seconds, verified_seconds
          FROM fam_role_email_verifications WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.email_digest === emailDigest && Number(current.verified_seconds) > 0) return { ok: true, already_verified: true };
        const windowStart = Number(current?.window_started_seconds ?? 0);
        const sendCount = Number(current?.send_count ?? 0);
        const sentSeconds = Number(current?.sent_seconds ?? 0);
        const sameWindow = windowStart > 0 && currentSeconds >= windowStart && currentSeconds - windowStart < 3600;
        if (sameWindow && sentSeconds > 0 && currentSeconds - sentSeconds < 60) {
          return { ok: false, code: 'email_send_cooldown', retry_after_seconds: 60 - (currentSeconds - sentSeconds) };
        }
        if (sameWindow && sendCount >= 3) return { ok: false, code: 'email_send_rate_limited' };
        const nextWindowStart = sameWindow ? windowStart : currentSeconds;
        const nextSendCount = sameWindow ? sendCount + 1 : 1;
        await tx`UPSERT INTO fam_role_email_verifications
          (issuer, subject, user_id, email_digest, code_digest, issued_seconds, expires_seconds,
           attempt_count, window_started_seconds, send_count, sent_seconds, verified_seconds)
          VALUES (${issuer}, ${subject}, ${userId}, ${emailDigest}, ${codeDigest}, ${new Uint64(BigInt(currentSeconds))}, ${new Uint64(BigInt(expiresSeconds))},
            ${new Uint32(0)}, ${new Uint64(BigInt(nextWindowStart))}, ${new Uint32(nextSendCount)}, ${new Uint64(BigInt(currentSeconds))}, ${new Uint64(0n)});`;
        return { ok: true, already_verified: false };
      });
    },

    async clearRoleEmailChallenge({ issuer, subject, codeDigest }) {
      if (!issuer || !subject || !/^[a-f0-9]{64}$/i.test(codeDigest || '')) throw new TypeError('invalid role email challenge cleanup');
      await sql`UPDATE fam_role_email_verifications SET code_digest = '', expires_seconds = 0, attempt_count = 0
        WHERE issuer = ${issuer} AND subject = ${subject} AND code_digest = ${codeDigest};`;
      return true;
    },

    async verifyRoleEmailVerification({ issuer, subject, userId, emailDigest, codeDigest, currentSeconds }) {
      if (!issuer || !subject || !userId || !/^[a-f0-9]{64}$/i.test(emailDigest || '')
          || !/^[a-f0-9]{64}$/i.test(codeDigest || '') || !Number.isSafeInteger(currentSeconds)) throw new TypeError('invalid role email verification');
      return sql.begin(async tx => {
        const rows = await tx`SELECT user_id, email_digest, code_digest, expires_seconds, attempt_count, verified_seconds
          FROM fam_role_email_verifications WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (!current || current.user_id !== userId || current.email_digest !== emailDigest) return { ok: false, code: 'invalid_verification_code' };
        if (Number(current.verified_seconds) > 0) return { ok: true, verified: true };
        if (Number(current.expires_seconds) <= currentSeconds) return { ok: false, code: 'verification_code_expired' };
        const attempts = Number(current.attempt_count ?? 0);
        if (attempts >= 5) return { ok: false, code: 'verification_code_locked' };
        const expected = Buffer.from(String(current.code_digest || ''), 'hex');
        const provided = Buffer.from(codeDigest, 'hex');
        if (expected.length !== 32 || !timingSafeEqual(expected, provided)) {
          await tx`UPDATE fam_role_email_verifications SET attempt_count = ${new Uint32(attempts + 1)}
            WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId}
              AND email_digest = ${emailDigest} AND verified_seconds = 0;`;
          return { ok: false, code: attempts + 1 >= 5 ? 'verification_code_locked' : 'invalid_verification_code' };
        }
        await tx`UPDATE fam_role_email_verifications SET verified_seconds = ${new Uint64(BigInt(currentSeconds))}
          WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId}
            AND email_digest = ${emailDigest} AND code_digest = ${codeDigest} AND verified_seconds = 0;`;
        const confirmed = await tx`SELECT verified_seconds FROM fam_role_email_verifications
          WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        return Number(confirmed?.[0]?.[0]?.verified_seconds) > 0
          ? { ok: true, verified: true } : { ok: false, code: 'invalid_verification_code' };
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
        const reviewerRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewerRows?.[0]?.[0];
        if (!reviewer || !reviewer.active || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId) return false;
        const requestRows = await tx`SELECT issuer, subject, user_id, school_id, requested_role, status, review_started_by FROM fam_school_role_requests WHERE request_id = ${requestId} LIMIT 1;`;
        const request = requestRows?.[0]?.[0];
        if (!request || request.school_id !== schoolId || request.user_id === reviewerId || request.status !== 'reviewing' || request.review_started_by !== reviewerId) return false;
        const applicantRows = await tx`SELECT user_id, school_id, role, active FROM fam_user_profiles WHERE issuer = ${request.issuer} AND subject = ${request.subject} LIMIT 1;`;
        const applicant = applicantRows?.[0]?.[0];
        if (!applicant || applicant.user_id !== request.user_id || applicant.school_id !== schoolId || !applicant.active || applicant.role !== 'student') return false;
        const status = decision === 'approve' ? 'approved' : 'rejected';
        if (decision === 'approve') await tx`UPDATE fam_user_profiles SET role = ${request.requested_role}
          WHERE issuer = ${request.issuer} AND subject = ${request.subject} AND user_id = ${request.user_id} AND school_id = ${schoolId} AND role = 'student' AND active = true;`;
        await tx`UPDATE fam_school_role_requests SET status = ${status}, reviewed_by = ${reviewerId}, reviewed_at = CurrentUtcTimestamp(), review_note = ${note}
          WHERE issuer = ${request.issuer} AND subject = ${request.subject} AND request_id = ${requestId} AND school_id = ${schoolId} AND status = 'reviewing' AND review_started_by = ${reviewerId};`;
        await tx`INSERT INTO fam_school_role_request_audit
          (event_id, request_id, school_id, actor_id, requested_role, action, status, created_at)
          VALUES (${randomUUID()}, ${requestId}, ${schoolId}, ${reviewerId}, ${request.requested_role}, ${decision}, ${status}, CurrentUtcTimestamp());`;
        const confirmed = await tx`SELECT status FROM fam_school_role_requests WHERE issuer = ${request.issuer} AND subject = ${request.subject} LIMIT 1;`;
        return confirmed?.[0]?.[0]?.status === status;
      });
    },

    async listSchoolRoleTargets(schoolId, actorId) {
      if (!schoolId || !actorId) throw new TypeError('invalid school role target lookup');
      const statement = sql`SELECT user_id AS id, role, first_name, last_name, class_name
        FROM fam_user_profiles WHERE school_id = ${schoolId} AND active = true
          AND user_id != ${actorId} AND role IN ('council_member', 'school_admin')
        ORDER BY role ASC, first_name ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async revokeSchoolRole({ schoolId, actorId, targetId }) {
      if (!schoolId || !actorId || !targetId || actorId === targetId) return { ok: false, code: 'invalid_target' };
      return sql.begin(async tx => {
        const actorRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${actorId} LIMIT 1;`;
        const actor = actorRows?.[0]?.[0];
        if (!actor || !actor.active || actor.role !== 'school_admin' || actor.school_id !== schoolId) return { ok: false, code: 'forbidden' };
        const targetRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${targetId} LIMIT 1;`;
        const target = targetRows?.[0]?.[0];
        if (!target || !target.active || target.school_id !== schoolId) return { ok: false, code: 'target_unavailable' };
        if (!['council_member', 'school_admin'].includes(target.role)) return { ok: false, code: 'role_unavailable' };
        if (target.role === 'school_admin') {
          const adminRows = await tx`SELECT user_id FROM fam_user_profiles WHERE school_id = ${schoolId} AND active = true AND role = 'school_admin';`;
          if ((adminRows?.[0] ?? []).length <= 1) return { ok: false, code: 'last_school_admin' };
        }
        const previousRole = target.role;
        await tx`UPDATE fam_user_profiles SET role = 'student' WHERE user_id = ${targetId} AND school_id = ${schoolId} AND role = ${previousRole} AND active = true;`;
        const confirmedRows = await tx`SELECT role FROM fam_user_profiles WHERE user_id = ${targetId} AND school_id = ${schoolId} LIMIT 1;`;
        if (confirmedRows?.[0]?.[0]?.role !== 'student') return { ok: false, code: 'role_update_failed' };
        await tx`INSERT INTO fam_school_admin_audit (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${actorId}, ${targetId}, 'role_revoked', ${previousRole}, CurrentUtcTimestamp());`;
        return { ok: true, target_id: targetId, previous_role: previousRole, role: 'student' };
      });
    },

    async getActiveAccountSuspension(schoolId, userId) {
      if (!schoolId || !userId) throw new TypeError('invalid suspension lookup');
      const statement = sql`SELECT reason, duration_hours, expires_at
        FROM fam_account_suspensions WHERE school_id = ${schoolId} AND target_id = ${userId}
          AND status = 'active' AND expires_at > CurrentUtcTimestamp() LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0]?.[0] ?? null;
    },

    async listAccountMediaKeys(userId) {
      if (!userId || !UUID.test(userId)) throw new TypeError('invalid account media owner');
      const rows = await sql`SELECT object_key FROM fam_idea_images WHERE user_id = ${userId};`;
      const avatars = await sql`SELECT image_key AS object_key FROM fam_avatar_reviews WHERE user_id = ${userId};`;
      const keys = [...(rows?.[0] ?? []), ...(avatars?.[0] ?? [])].map(row => row.object_key);
      const keyPattern = new RegExp(`^pending/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i');
      if (keys.some(key => typeof key !== 'string' || !keyPattern.test(key))) throw new Error('invalid account media key');
      return [...new Set(keys)];
    },
    async listActiveAccountSuspensions(schoolId) {
      if (!schoolId) throw new TypeError('invalid suspension school');
      const statement = sql`SELECT target_id, target_role, duration_hours, reason, created_at, expires_at
        FROM fam_account_suspensions WHERE school_id = ${schoolId} AND status = 'active'
          AND expires_at > CurrentUtcTimestamp() ORDER BY expires_at ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },
    async listSuspensionTargets(schoolId, actorId) {
      if (!schoolId || !actorId) throw new TypeError('invalid suspension target lookup');
      const statement = sql`SELECT user_id AS id, role, first_name, last_name, class_name
        FROM fam_user_profiles WHERE school_id = ${schoolId} AND active = true AND user_id != ${actorId}
          AND role IN ('student', 'council_member') ORDER BY first_name ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },
    async issueAccountSuspension({ schoolId, targetId, actorId, durationHours, reason }) {
      if (!schoolId || !targetId || !actorId || ![24, 72, 168].includes(durationHours)
          || typeof reason !== 'string' || reason.length < 15 || reason.length > 400) throw new TypeError('invalid account suspension');
      const suspensionId = randomUUID();
      return sql.begin(async tx => {
        const admins = await tx`SELECT school_id FROM fam_user_profiles WHERE user_id = ${actorId}
          AND active = true AND role = 'school_admin' LIMIT 1;`;
        if (admins?.[0]?.[0]?.school_id !== schoolId) return { ok: false, code: 'forbidden' };
        const targets = await tx`SELECT school_id, role FROM fam_user_profiles WHERE user_id = ${targetId} AND active = true LIMIT 1;`;
        const target = targets?.[0]?.[0];
        if (!target || target.school_id !== schoolId || !['student', 'council_member'].includes(target.role)) return { ok: false, code: 'target_unavailable' };
        const activeRows = await tx`SELECT suspension_id FROM fam_account_suspensions
          WHERE school_id = ${schoolId} AND target_id = ${targetId} AND status = 'active'
            AND expires_at > CurrentUtcTimestamp() LIMIT 1;`;
        if (activeRows?.[0]?.length) return { ok: false, code: 'already_suspended' };
        const openRows = await tx`SELECT suspension_id FROM fam_account_suspension_open WHERE target_id = ${targetId} LIMIT 1;`;
        const staleOpen = openRows?.[0]?.[0];
        if (staleOpen?.suspension_id) {
          await tx`DELETE FROM fam_account_suspension_open WHERE target_id = ${targetId} AND suspension_id = ${staleOpen.suspension_id};`;
          await tx`UPDATE fam_account_suspensions SET status = 'expired'
            WHERE school_id = ${schoolId} AND target_id = ${targetId} AND suspension_id = ${staleOpen.suspension_id} AND status = 'active';`;
        }
        if (durationHours === 24) {
          await tx`INSERT INTO fam_account_suspensions
            (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at, lifted_by, lifted_at)
            VALUES (${schoolId}, ${targetId}, ${suspensionId}, ${target.role}, Unwrap(CAST(24 AS Uint32)), ${reason}, 'active', ${actorId}, CurrentUtcTimestamp(), Unwrap(CurrentUtcTimestamp() + Interval('PT24H')), NULL, NULL);`;
        } else if (durationHours === 72) {
          await tx`INSERT INTO fam_account_suspensions
            (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at, lifted_by, lifted_at)
            VALUES (${schoolId}, ${targetId}, ${suspensionId}, ${target.role}, Unwrap(CAST(72 AS Uint32)), ${reason}, 'active', ${actorId}, CurrentUtcTimestamp(), Unwrap(CurrentUtcTimestamp() + Interval('PT72H')), NULL, NULL);`;
        } else {
          await tx`INSERT INTO fam_account_suspensions
            (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at, lifted_by, lifted_at)
            VALUES (${schoolId}, ${targetId}, ${suspensionId}, ${target.role}, Unwrap(CAST(168 AS Uint32)), ${reason}, 'active', ${actorId}, CurrentUtcTimestamp(), Unwrap(CurrentUtcTimestamp() + Interval('PT168H')), NULL, NULL);`;
        }
        const inserted = await tx`SELECT suspension_id, target_id, target_role, duration_hours, reason, status, created_at, expires_at
          FROM fam_account_suspensions WHERE target_id = ${targetId} AND suspension_id = ${suspensionId} LIMIT 1;`;
        const suspension = inserted?.[0]?.[0];
        if (!suspension) return { ok: false, code: 'suspension_failed' };
        await tx`INSERT INTO fam_account_suspension_open (target_id, school_id, suspension_id, created_at)
          VALUES (${targetId}, ${schoolId}, ${suspensionId}, CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_account_suspension_audit
          (event_id, school_id, target_id, actor_id, suspension_id, action, duration_hours, reason, expires_at, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${targetId}, ${actorId}, ${suspensionId}, 'issued', Unwrap(CAST(${durationHours} AS Uint32)), ${reason}, CAST(${suspension.expires_at} AS Timestamp), CurrentUtcTimestamp());`;
        return { ok: true, suspension };
      });
    },
    async liftAccountSuspension({ schoolId, targetId, actorId }) {
      if (!schoolId || !targetId || !actorId) throw new TypeError('invalid account suspension lift');
      return sql.begin(async tx => {
        const admins = await tx`SELECT school_id FROM fam_user_profiles WHERE user_id = ${actorId}
          AND active = true AND role = 'school_admin' LIMIT 1;`;
        if (admins?.[0]?.[0]?.school_id !== schoolId) return false;
        const targets = await tx`SELECT school_id, role FROM fam_user_profiles WHERE user_id = ${targetId} AND active = true LIMIT 1;`;
        const target = targets?.[0]?.[0];
        if (!target || target.school_id !== schoolId || !['student', 'council_member'].includes(target.role)) return false;
        const rows = await tx`SELECT suspension_id, duration_hours, reason, expires_at FROM fam_account_suspensions
          WHERE school_id = ${schoolId} AND target_id = ${targetId} AND status = 'active'
            AND expires_at > CurrentUtcTimestamp() ORDER BY created_at DESC LIMIT 1;`;
        const suspension = rows?.[0]?.[0];
        if (!suspension) return false;
        await tx`UPDATE fam_account_suspensions SET status = 'lifted', lifted_by = ${actorId}, lifted_at = CurrentUtcTimestamp()
          WHERE school_id = ${schoolId} AND target_id = ${targetId} AND suspension_id = ${suspension.suspension_id}
            AND status = 'active' AND expires_at > CurrentUtcTimestamp();`;
        const changed = await tx`SELECT status FROM fam_account_suspensions
          WHERE school_id = ${schoolId} AND target_id = ${targetId} AND suspension_id = ${suspension.suspension_id} LIMIT 1;`;
        if (changed?.[0]?.[0]?.status !== 'lifted') return false;
        await tx`DELETE FROM fam_account_suspension_open WHERE target_id = ${targetId}
          AND school_id = ${schoolId} AND suspension_id = ${suspension.suspension_id};`;
        await tx`INSERT INTO fam_account_suspension_audit
          (event_id, school_id, target_id, actor_id, suspension_id, action, duration_hours, reason, expires_at, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${targetId}, ${actorId}, ${suspension.suspension_id}, 'lifted', Unwrap(CAST(${suspension.duration_hours} AS Uint32)), ${suspension.reason}, CAST(${suspension.expires_at} AS Timestamp), CurrentUtcTimestamp());`;
        return true;
      });
    },
    async listAccountDeletionTargets(schoolId, requesterId) {
      if (!schoolId || !requesterId) throw new TypeError('invalid deletion request target lookup');
      const statement = sql`SELECT user_id AS id, role, first_name, last_name, class_name
        FROM fam_user_profiles WHERE school_id = ${schoolId} AND active = true
          AND user_id != ${requesterId} AND role IN ('student', 'council_member')
        ORDER BY first_name ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },
    async listSchoolSafetyReports(schoolId) {
      if (typeof schoolId !== 'string' || !schoolId) throw new TypeError('invalid safety report school');
      const cleanup = sql`DELETE FROM fam_safety_incidents WHERE school_id = ${schoolId}
        AND created_at < CurrentUtcTimestamp() - Interval('P90D');`;
      if (typeof cleanup?.on === 'function') cleanup.on('error', () => {});
      await cleanup;
      const statement = sql`SELECT pair_fingerprint, source_kind, category, severity, created_at,
          actor_id, target_id, source_origin, evidence_excerpt
        FROM fam_safety_incidents WHERE school_id = ${schoolId} AND reviewed_at IS NULL
          AND created_at >= CurrentUtcTimestamp() - Interval('P30D')
        ORDER BY created_at DESC LIMIT 400;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const rows = (await statement)?.[0] ?? [];
      const allowedSources = new Set(['message', 'idea', 'listing', 'image']);
      const allowedCategories = new Set(['targeted_harassment', 'hate_or_discrimination', 'threat_or_intimidation',
        'negative_personal_call', 'spam_or_repeated_abuse', 'unsafe_image', 'personal_data_in_image', 'unclear_safety_signal']);
      const grouped = new Map();
      const time = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value ?? '')) || 0;
      const iso = value => { const parsed = time(value); return parsed ? new Date(parsed).toISOString() : null; };
      for (const row of rows) {
        if (!/^[0-9a-f]{64}$/.test(row.pair_fingerprint || '') || !allowedSources.has(row.source_kind)
            || !allowedCategories.has(row.category) || !['medium', 'high'].includes(row.severity)) continue;
        const key = [row.pair_fingerprint, row.source_kind, row.category].join('|');
        let current = grouped.get(key);
        if (!current) {
          current = { fingerprint: row.pair_fingerprint, source_kind: row.source_kind, category: row.category,
            occurrences: 0, severity: 'medium', first_seen: iso(row.created_at), last_seen: iso(row.created_at),
            actor_id: typeof row.actor_id === 'string' && /^[0-9a-f-]{36}$/i.test(row.actor_id) ? row.actor_id : null,
            target_id: typeof row.target_id === 'string' && /^[0-9a-f-]{36}$/i.test(row.target_id) ? row.target_id : null,
            source_origin: typeof row.source_origin === 'string' && /^[a-z0-9.-]{1,120}$/.test(row.source_origin) ? row.source_origin : null,
            evidence_excerpt: typeof row.evidence_excerpt === 'string' && row.evidence_excerpt.length <= 260 ? row.evidence_excerpt : null };
          grouped.set(key, current);
        }
        current.occurrences++;
        if (row.severity === 'high' || current.occurrences >= 3) current.severity = 'high';
        const rowTime = time(row.created_at);
        if (!current.first_seen || rowTime < time(current.first_seen)) current.first_seen = iso(row.created_at);
        if (!current.last_seen || rowTime > time(current.last_seen)) current.last_seen = iso(row.created_at);
      }
      const reports = [...grouped.values()].sort((a, b) => time(b.last_seen) - time(a.last_seen)).slice(0, 50);
      const profileIds = [...new Set(reports.flatMap(row => [row.actor_id, row.target_id]).filter(Boolean))];
      const profiles = await Promise.all(profileIds.map(async id => {
        const query = sql`SELECT user_id AS id, role, first_name, last_name, class_name FROM fam_user_profiles
          WHERE school_id = ${schoolId} AND user_id = ${id} LIMIT 1;`;
        if (typeof query?.on === 'function') query.on('error', () => {});
        return (await query)?.[0]?.[0] ?? null;
      }));
      const byId = new Map(profiles.filter(Boolean).map(profile => [profile.id, profile]));
      const person = id => {
        const profile = id ? byId.get(id) : null;
        return profile ? { role: profile.role, first_name: profile.first_name ?? null,
          last_name: profile.last_name ?? null, class_name: profile.class_name ?? null,
          account_code: profile.id.slice(-6).toUpperCase() } : null;
      };
      return { reports: reports.map(row => ({
        fingerprint: row.fingerprint, source_kind: row.source_kind, category: row.category,
        occurrences: row.occurrences, severity: row.severity, repeated: row.occurrences >= 3,
        first_seen: row.first_seen, last_seen: row.last_seen, source_origin: row.source_origin,
        evidence_excerpt: row.evidence_excerpt, actor: person(row.actor_id), target: person(row.target_id),
        identity_was_recorded: Boolean(row.actor_id),
      })), period_days: 30 };
    },

    async recordSafetySignal({ schoolId, fingerprint, sourceKind, category, severity, actorId, targetId = null, sourceOrigin }) {
      const sources = new Set(['message', 'idea', 'listing', 'image']);
      const categories = new Set(['targeted_harassment', 'hate_or_discrimination', 'threat_or_intimidation',
        'negative_personal_call', 'spam_or_repeated_abuse', 'unsafe_image', 'personal_data_in_image', 'unclear_safety_signal']);
      if (!schoolId || !/^[0-9a-f]{64}$/.test(fingerprint || '') || !sources.has(sourceKind) || !categories.has(category)
          || !['medium', 'high'].includes(severity) || !UUID.test(actorId || '')
          || (targetId !== null && !UUID.test(targetId || '')) || !/^[a-z0-9.-]{1,120}$/.test(sourceOrigin || '')) {
        throw new TypeError('invalid safety signal');
      }
      const incidentId = randomUUID();
      const statement = sql`INSERT INTO fam_safety_incidents
        (school_id, pair_fingerprint, source_kind, category, incident_id, severity, created_at, reviewed_at,
          reviewed_by, actor_id, target_id, source_origin, evidence_excerpt)
        VALUES (${schoolId}, ${fingerprint}, ${sourceKind}, ${category}, ${incidentId}, ${severity}, CurrentUtcTimestamp(),
          NULL, NULL, ${actorId}, CAST(${targetId} AS Utf8?), ${sourceOrigin}, NULL);`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      await statement;
      return true;
    },

    async acknowledgeSchoolSafetyReport({ schoolId, reviewerId, fingerprint, category, sourceKind }) {
      const sources = new Set(['message', 'idea', 'listing', 'image']);
      const categories = new Set(['targeted_harassment', 'hate_or_discrimination', 'threat_or_intimidation',
        'negative_personal_call', 'spam_or_repeated_abuse', 'unsafe_image', 'personal_data_in_image', 'unclear_safety_signal']);
      if (!schoolId || !reviewerId || !/^[0-9a-f]{64}$/.test(fingerprint || '')
          || !categories.has(category) || !sources.has(sourceKind)) throw new TypeError('invalid safety report acknowledgement');
      return sql.begin(async tx => {
        const matches = await tx`SELECT incident_id FROM fam_safety_incidents WHERE school_id = ${schoolId}
          AND pair_fingerprint = ${fingerprint} AND source_kind = ${sourceKind} AND category = ${category}
          AND reviewed_at IS NULL LIMIT 400;`;
        if (!(matches?.[0] ?? []).length) return false;
        await tx`UPDATE fam_safety_incidents SET reviewed_at = CurrentUtcTimestamp(), reviewed_by = ${reviewerId}
          WHERE school_id = ${schoolId} AND pair_fingerprint = ${fingerprint}
            AND source_kind = ${sourceKind} AND category = ${category} AND reviewed_at IS NULL;`;
        return true;
      });
    },

    async getSchoolAdminOverview(schoolId) {
      if (!schoolId) throw new TypeError('invalid school overview school');
      const queryRows = async statement => {
        if (typeof statement?.on === 'function') statement.on('error', () => {});
        return (await statement)?.[0] ?? [];
      };
      const [users, listings, roleAudit, suspensionAudit, contentAudit, deletionRequests, suspensions] = await Promise.all([
        queryRows(sql`SELECT user_id AS id, role, first_name, last_name, class_name FROM fam_user_profiles
          WHERE school_id = ${schoolId} AND active = true ORDER BY role ASC, first_name ASC LIMIT 100;`),
        queryRows(sql`SELECT id, title, description, price_text, category, user_id, status, is_event,
          event_date, created_at, photo_status FROM fam_listings WHERE school_id = ${schoolId}
          ORDER BY created_at DESC LIMIT 100;`),
        queryRows(sql`SELECT actor_id, target_id, action, created_at FROM fam_school_admin_audit
          WHERE school_id = ${schoolId} ORDER BY created_at DESC LIMIT 20;`),
        queryRows(sql`SELECT actor_id, target_id, action, created_at FROM fam_account_suspension_audit
          WHERE school_id = ${schoolId} ORDER BY created_at DESC LIMIT 20;`),
        queryRows(sql`SELECT actor_id, entity_id AS target_id, action, created_at FROM fam_school_content_audit
          WHERE school_id = ${schoolId} ORDER BY created_at DESC LIMIT 20;`),
        queryRows(sql`SELECT request_id AS id, requester_id, target_id, target_role, reason_code, reason, status, created_at
          FROM fam_account_deletion_requests WHERE school_id = ${schoolId}
          AND (status = 'pending' OR status = 'processing') ORDER BY created_at ASC LIMIT 50;`),
        queryRows(sql`SELECT suspension_id AS id, target_id, target_role, duration_hours, reason, expires_at, created_at
          FROM fam_account_suspensions WHERE school_id = ${schoolId} AND status = 'active'
          AND expires_at > CurrentUtcTimestamp() ORDER BY expires_at ASC LIMIT 100;`),
      ]);
      const timestamp = value => {
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return value;
        const parsed = Date.parse(String(value ?? ''));
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const audit = [...roleAudit, ...suspensionAudit, ...contentAudit]
        .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at))
        .slice(0, 20).map(row => ({
          actor: typeof row.actor_id === 'string' ? row.actor_id.slice(0, 8) : '',
          target: typeof row.target_id === 'string' ? row.target_id.slice(0, 8) : '',
          action: row.action,
          created_at: row.created_at,
        }));
      return {
        users: users.map(({ id, role, first_name, last_name, class_name }) => ({ id, role, first_name: first_name ?? null, last_name: last_name ?? null, class_name: class_name ?? null, created_at: null })),
        listings: listings.map(row => ({ ...row, moderation_status: row.status === 'rejected' || row.photo_status === 'rejected' ? 'rejected' : row.status === 'pending' ? 'pending' : 'approved', city: null })),
        audit,
        deletion_requests: deletionRequests.map(row => ({ ...row, target_email: 'Аккаунт', requester_email: 'Участник совета' })),
        suspensions,
      };
    },

    async listPendingAccountDeletionRequests(schoolId) {
      if (!schoolId) throw new TypeError('invalid deletion request school');
      const statement = sql`SELECT request_id, requester_id, target_id, target_role, reason_code, reason, created_at
        FROM fam_account_deletion_requests WHERE school_id = ${schoolId} AND status = 'pending'
        ORDER BY created_at ASC LIMIT 50;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },
    async listOwnAccountDeletionRequests(schoolId, requesterId) {
      if (!schoolId || !requesterId) throw new TypeError('invalid own deletion request lookup');
      const statement = sql`SELECT request_id, target_role, reason_code, reason, status, review_note, created_at, reviewed_at
        FROM fam_account_deletion_requests WHERE school_id = ${schoolId} AND requester_id = ${requesterId}
        ORDER BY created_at DESC LIMIT 10;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },
    async createAccountDeletionRequest({ schoolId, requesterId, targetId, reasonCode, reason }) {
      if (!schoolId || !requesterId || !targetId || requesterId === targetId
          || !['rules_violation', 'harassment', 'fake_account', 'spam', 'other'].includes(reasonCode)
          || typeof reason !== 'string' || reason.length < 15 || reason.length > 500) throw new TypeError('invalid account deletion request');
      const requestId = randomUUID();
      return sql.begin(async tx => {
        const requesterRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${requesterId} LIMIT 1;`;
        const requester = requesterRows?.[0]?.[0];
        if (!requester || !requester.active || requester.role !== 'council_member' || requester.school_id !== schoolId) return { ok: false, code: 'requester_unavailable' };
        const targetRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${targetId} LIMIT 1;`;
        const target = targetRows?.[0]?.[0];
        if (!target || !target.active || !['student', 'council_member'].includes(target.role) || target.school_id !== schoolId) return { ok: false, code: 'target_unavailable' };
        const existingRows = await tx`SELECT request_id, school_id FROM fam_account_deletion_open
          WHERE target_id = ${targetId} LIMIT 1;`;
        const existing = existingRows?.[0]?.[0];
        if (existing?.school_id === schoolId) return { ok: true, already_exists: true, request_id: existing.request_id };
        if (existing) return { ok: false, code: 'target_unavailable' };
        await tx`INSERT INTO fam_account_deletion_requests
          (request_id, school_id, requester_id, target_id, target_role, reason_code, reason, status,
           reviewed_by, reviewed_at, review_note, created_at)
          VALUES (${requestId}, ${schoolId}, ${requesterId}, ${targetId}, ${target.role}, ${reasonCode}, ${reason},
            'pending', NULL, NULL, NULL, CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_account_deletion_open (target_id, request_id, school_id, created_at)
          VALUES (${targetId}, ${requestId}, ${schoolId}, CurrentUtcTimestamp());`;
        return { ok: true, already_exists: false, request_id: requestId };
      });
    },
    async rejectAccountDeletionRequest(requestId, schoolId, reviewerId, reviewNote = '') {
      if (!requestId || !schoolId || !reviewerId || typeof reviewNote !== 'string' || reviewNote.length > 240) throw new TypeError('invalid deletion request decision');
      return sql.begin(async tx => {
        const reviewers = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewers?.[0]?.[0];
        if (!reviewer || !reviewer.active || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId) return false;
        const requests = await tx`SELECT target_id, school_id, status FROM fam_account_deletion_requests WHERE request_id = ${requestId} LIMIT 1;`;
        const request = requests?.[0]?.[0];
        if (!request || request.school_id !== schoolId || request.status !== 'pending') return false;
        const openRows = await tx`SELECT request_id, school_id FROM fam_account_deletion_open WHERE target_id = ${request.target_id} LIMIT 1;`;
        const openRequest = openRows?.[0]?.[0];
        if (openRequest?.request_id !== requestId || openRequest.school_id !== schoolId) return false;
        await tx`UPDATE fam_account_deletion_requests SET status = 'rejected', reviewed_by = ${reviewerId},
          reviewed_at = CurrentUtcTimestamp(), review_note = ${reviewNote}
          WHERE request_id = ${requestId} AND school_id = ${schoolId} AND status = 'pending';`;
        await tx`DELETE FROM fam_account_deletion_open WHERE target_id = ${request.target_id}
          AND request_id = ${requestId} AND school_id = ${schoolId};`;
        const confirmed = await tx`SELECT status FROM fam_account_deletion_requests WHERE request_id = ${requestId} LIMIT 1;`;
        return confirmed?.[0]?.[0]?.status === 'rejected';
      });
    },

    async beginRequestedAccountDeletion({ requestId, schoolId, reviewerId, reviewNote = '' }) {
      if (!requestId || !schoolId || !reviewerId) throw new TypeError('invalid requested account deletion');
      if (typeof reviewNote !== 'string' || reviewNote.length > 240) throw new TypeError('invalid deletion review note');
      return sql.begin(async tx => {
        const reviewerRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewerRows?.[0]?.[0];
        if (!reviewer || reviewer.active !== true || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId) return { ok: false, code: 'forbidden' };
        const requestRows = await tx`SELECT target_id, school_id, status FROM fam_account_deletion_requests WHERE request_id = ${requestId} LIMIT 1;`;
        const request = requestRows?.[0]?.[0];
        if (!request || request.school_id !== schoolId || request.status !== 'pending' || request.target_id === reviewerId) return { ok: false, code: 'request_unavailable' };
        const openRows = await tx`SELECT request_id, school_id FROM fam_account_deletion_open WHERE target_id = ${request.target_id} LIMIT 1;`;
        const openRequest = openRows?.[0]?.[0];
        if (openRequest?.request_id !== requestId || openRequest.school_id !== schoolId) return { ok: false, code: 'request_unavailable' };
        const targetRows = await tx`SELECT user_id, issuer, subject, school_id, role, active FROM fam_user_profiles WHERE user_id = ${request.target_id} LIMIT 1;`;
        const target = targetRows?.[0]?.[0];
        if (!target || target.active !== true || target.school_id !== schoolId || !['student', 'council_member'].includes(target.role)) {
          return { ok: false, code: 'target_unavailable' };
        }
        await tx`UPDATE fam_user_profiles SET active = false WHERE user_id = ${target.user_id} AND active = true AND school_id = ${schoolId};`;
        await tx`UPDATE fam_account_deletion_requests SET status = 'processing', reviewed_by = ${reviewerId}
          WHERE request_id = ${requestId} AND school_id = ${schoolId} AND status = 'pending';`;
        const confirmed = await tx`SELECT active FROM fam_user_profiles WHERE user_id = ${target.user_id} LIMIT 1;`;
        const claimed = await tx`SELECT status FROM fam_account_deletion_requests WHERE request_id = ${requestId} LIMIT 1;`;
        if (confirmed?.[0]?.[0]?.active !== false || claimed?.[0]?.[0]?.status !== 'processing') return { ok: false, code: 'request_unavailable' };
        const claimToken = randomUUID();
        await tx`INSERT INTO fam_account_deletion_jobs
          (user_id, issuer, subject, school_id, source, actor_id, request_id, target_role, review_note,
            claim_token, claim_until, created_at)
          VALUES (${target.user_id}, ${target.issuer}, ${target.subject}, ${schoolId}, 'council_request', ${reviewerId},
            ${requestId}, ${target.role}, ${reviewNote}, ${claimToken}, Unwrap(CurrentUtcTimestamp() + Interval('PT5M')), CurrentUtcTimestamp());`;
        return { ok: true, id: target.user_id, issuer: target.issuer, subject: target.subject, school_id: target.school_id, claim_token: claimToken };
      });
    },

    async restoreRequestedAccountDeletion({ requestId, schoolId, reviewerId, targetId, claimToken }) {
      if (!requestId || !schoolId || !reviewerId || !targetId || !claimToken) return false;
      return sql.begin(async tx => {
        const jobs = await tx`SELECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${targetId}
          AND request_id = ${requestId} AND actor_id = ${reviewerId} AND claim_token = ${claimToken}
          AND claim_until > CurrentUtcTimestamp() LIMIT 1;`;
        if (!jobs?.[0]?.length) return false;
        const requests = await tx`SELECT target_id, status, reviewed_by FROM fam_account_deletion_requests
          WHERE request_id = ${requestId} AND school_id = ${schoolId} LIMIT 1;`;
        const request = requests?.[0]?.[0];
        if (!request || request.target_id !== targetId || request.status !== 'processing' || request.reviewed_by !== reviewerId) return false;
        await tx`UPDATE fam_user_profiles SET active = true WHERE user_id = ${targetId} AND school_id = ${schoolId} AND active = false;`;
        await tx`UPDATE fam_account_deletion_requests SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
          WHERE request_id = ${requestId} AND school_id = ${schoolId} AND status = 'processing' AND reviewed_by = ${reviewerId};`;
        const profile = await tx`SELECT active FROM fam_user_profiles WHERE user_id = ${targetId} LIMIT 1;`;
        const restored = await tx`SELECT status FROM fam_account_deletion_requests WHERE request_id = ${requestId} LIMIT 1;`;
        if (profile?.[0]?.[0]?.active !== true || restored?.[0]?.[0]?.status !== 'pending') return false;
        await tx`DELETE FROM fam_account_deletion_jobs WHERE user_id = ${targetId} AND claim_token = ${claimToken};`;
        return true;
      });
    },

    async beginAdminAccountDeletion({ schoolId, reviewerId, targetId }) {
      if (!schoolId || !reviewerId || !targetId || reviewerId === targetId) throw new TypeError('invalid administrator account deletion');
      return sql.begin(async tx => {
        const reviewerRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewerRows?.[0]?.[0];
        if (!reviewer || reviewer.active !== true || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId) return { ok: false, code: 'forbidden' };
        const targetRows = await tx`SELECT user_id, issuer, subject, school_id, role, active FROM fam_user_profiles WHERE user_id = ${targetId} LIMIT 1;`;
        const target = targetRows?.[0]?.[0];
        if (!target || target.active !== true || target.school_id !== schoolId) return { ok: false, code: 'target_unavailable' };
        if (!['student', 'council_member'].includes(target.role)) return { ok: false, code: 'target_role_forbidden' };
        await tx`UPDATE fam_user_profiles SET active = false WHERE user_id = ${targetId} AND school_id = ${schoolId}
          AND role IN ('student', 'council_member') AND active = true;`;
        const confirmed = await tx`SELECT active FROM fam_user_profiles WHERE user_id = ${targetId} AND school_id = ${schoolId} LIMIT 1;`;
        if (confirmed?.[0]?.[0]?.active !== false) return { ok: false, code: 'target_unavailable' };
        const claimToken = randomUUID();
        await tx`INSERT INTO fam_account_deletion_jobs
          (user_id, issuer, subject, school_id, source, actor_id, request_id, target_role, review_note,
            claim_token, claim_until, created_at)
          VALUES (${target.user_id}, ${target.issuer}, ${target.subject}, ${schoolId}, 'school_admin', ${reviewerId},
            '', ${target.role}, '', ${claimToken}, Unwrap(CurrentUtcTimestamp() + Interval('PT5M')), CurrentUtcTimestamp());`;
        return { ok: true, id: target.user_id, issuer: target.issuer, subject: target.subject,
          school_id: target.school_id, role: target.role, claim_token: claimToken };
      });
    },

    async beginAccountDeletion({ issuer, subject, userId }) {
      if (!issuer || !subject || !userId) throw new TypeError('invalid account deletion actor');
      return sql.begin(async tx => {
        const profileRows = await tx`SELECT user_id, school_id, role, active FROM fam_user_profiles
          WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const profile = profileRows?.[0]?.[0];
        if (!profile || profile.user_id !== userId || profile.active !== true) return { ok: false, code: 'profile_unavailable' };
        if (profile.role === 'school_admin') {
          const admins = await tx`SELECT user_id FROM fam_user_profiles
            WHERE school_id = ${profile.school_id} AND role = 'school_admin' AND active = true AND user_id != ${userId} LIMIT 1;`;
          if (!(admins?.[0] ?? []).length) return { ok: false, code: 'last_school_admin' };
        }
        await tx`UPDATE fam_user_profiles SET active = false
          WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} AND active = true;`;
        const inactive = await tx`SELECT active FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} LIMIT 1;`;
        if (inactive?.[0]?.[0]?.active !== false) return { ok: false, code: 'profile_unavailable' };
        const claimToken = randomUUID();
        await tx`INSERT INTO fam_account_deletion_jobs
          (user_id, issuer, subject, school_id, source, actor_id, request_id, target_role, review_note,
            claim_token, claim_until, created_at)
          VALUES (${userId}, ${issuer}, ${subject}, ${profile.school_id}, 'self', ${userId}, '',
            ${profile.role}, '', ${claimToken}, Unwrap(CurrentUtcTimestamp() + Interval('PT5M')), CurrentUtcTimestamp());`;
        return { ok: true, school_id: profile.school_id, role: profile.role, claim_token: claimToken };
      });
    },

    async restoreAccountAfterDeletionFailure({ issuer, subject, userId, claimToken }) {
      if (!issuer || !subject || !userId || !claimToken) return false;
      return sql.begin(async tx => {
        const jobs = await tx`SELECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${userId}
          AND issuer = ${issuer} AND subject = ${subject} AND claim_token = ${claimToken}
          AND claim_until > CurrentUtcTimestamp() LIMIT 1;`;
        if (!jobs?.[0]?.length) return false;
        const rows = await tx`SELECT active FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} LIMIT 1;`;
        if (!rows?.[0]?.length || rows[0][0].active !== false) return false;
        await tx`UPDATE fam_user_profiles SET active = true
          WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} AND active = false;`;
        const confirmed = await tx`SELECT active FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} LIMIT 1;`;
        if (confirmed?.[0]?.[0]?.active !== true) return false;
        await tx`DELETE FROM fam_account_deletion_jobs WHERE user_id = ${userId} AND claim_token = ${claimToken};`;
        return true;
      });
    },

    async claimIncompleteAccountDeletions(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('invalid account deletion recovery limit');
      return sql.begin(async tx => {
        const expired = await tx`SELECT user_id FROM fam_account_deletion_jobs
          WHERE claim_until <= CurrentUtcTimestamp() ORDER BY created_at ASC LIMIT ${limit};`;
        const claims = [];
        for (const row of expired?.[0] ?? []) {
          const claimToken = randomUUID();
          await tx`UPDATE fam_account_deletion_jobs SET claim_token = ${claimToken},
              claim_until = Unwrap(CurrentUtcTimestamp() + Interval('PT5M'))
            WHERE user_id = ${row.user_id} AND claim_until <= CurrentUtcTimestamp();`;
          const claimed = await tx`SELECT user_id, issuer, subject, school_id, source, actor_id,
              request_id, target_role, review_note, claim_token
            FROM fam_account_deletion_jobs WHERE user_id = ${row.user_id} AND claim_token = ${claimToken}
              AND claim_until > CurrentUtcTimestamp() LIMIT 1;`;
          if (claimed?.[0]?.[0]) claims.push(claimed[0][0]);
        }
        return claims;
      });
    },

    async finishAccountDeletion({ issuer, subject, userId, schoolId, claimToken }) {
      if (!issuer || !subject || !userId || !schoolId || !claimToken) throw new TypeError('invalid account deletion');
      return sql.begin(async tx => {
        const jobRows = await tx`SELECT issuer, subject, school_id, source, actor_id, request_id,
            target_role, review_note, claim_until > CurrentUtcTimestamp() AS lease_valid
          FROM fam_account_deletion_jobs WHERE user_id = ${userId} AND claim_token = ${claimToken} LIMIT 1;`;
        const job = jobRows?.[0]?.[0];
        if (!job || job.lease_valid !== true || job.issuer !== issuer || job.subject !== subject || job.school_id !== schoolId) {
          return { ok: false, code: 'deletion_job_unavailable' };
        }
        const preserveRequestId = job.request_id || null;
        const reviewerId = job.source === 'self' ? null : job.actor_id;
        const reviewNote = job.review_note;
        const adminAudit = job.source === 'school_admin'
          ? { actorId: job.actor_id, schoolId: job.school_id, targetRole: job.target_role } : null;
        const profileRows = await tx`SELECT active, school_id FROM fam_user_profiles
          WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} LIMIT 1;`;
        const profile = profileRows?.[0]?.[0];
        if (!profile || profile.active !== false || profile.school_id !== schoolId) return { ok: false, code: 'profile_unavailable' };
        if (adminAudit) {
          const reviewers = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${adminAudit.actorId} LIMIT 1;`;
          const reviewer = reviewers?.[0]?.[0];
          if (!reviewer || reviewer.active !== true || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId
              || adminAudit.schoolId !== schoolId || !['student', 'council_member'].includes(adminAudit.targetRole)) {
            return { ok: false, code: 'forbidden' };
          }
        }

        const listingRows = await tx`SELECT id FROM fam_listings WHERE user_id = ${userId};`;
        const listingIds = (listingRows?.[0] ?? []).map(row => row.id).filter(id => typeof id === 'string');
        const ownListingIds = new Set(listingIds);
        const registrationRows = await tx`SELECT event_id, status FROM fam_event_registrations WHERE user_id = ${userId};`;
        for (const registration of registrationRows?.[0] ?? []) {
          if (ownListingIds.has(registration.event_id)) continue;
          if (['pending', 'confirmed'].includes(registration.status)) {
            const occupancyRows = await tx`SELECT taken FROM fam_event_occupancy WHERE event_id = ${registration.event_id} LIMIT 1;`;
            const taken = Number(occupancyRows?.[0]?.[0]?.taken ?? 0);
            await tx`UPSERT INTO fam_event_occupancy (event_id, taken)
              VALUES (${registration.event_id}, Unwrap(CAST(${Math.max(0, taken - 1)} AS Uint32)));`;
          }
          await tx`DELETE FROM fam_event_registrations WHERE event_id = ${registration.event_id} AND user_id = ${userId};`;
        }
        for (const listingId of listingIds) {
          await tx`DELETE FROM fam_favorites WHERE listing_id = ${listingId};`;
          await tx`DELETE FROM fam_event_registrations WHERE event_id = ${listingId};`;
          await tx`DELETE FROM fam_event_occupancy WHERE event_id = ${listingId};`;
          await tx`DELETE FROM fam_listings WHERE id = ${listingId} AND user_id = ${userId};`;
        }

        const pollRows = await tx`SELECT poll_id FROM fam_school_polls WHERE author_id = ${userId};`;
        for (const poll of pollRows?.[0] ?? []) {
          await tx`DELETE FROM fam_school_poll_votes WHERE poll_id = ${poll.poll_id};`;
          await tx`DELETE FROM fam_school_polls WHERE poll_id = ${poll.poll_id} AND author_id = ${userId};`;
        }
        if (preserveRequestId) {
          const approvedRequest = await tx`SELECT target_id, school_id, status FROM fam_account_deletion_requests
            WHERE request_id = ${preserveRequestId} AND school_id = ${schoolId} AND status = 'processing' LIMIT 1;`;
          const row = approvedRequest?.[0]?.[0];
          if (!reviewerId || typeof reviewNote !== 'string' || reviewNote.length > 240 || row?.target_id !== userId) return { ok: false, code: 'request_unavailable' };
          await tx`UPDATE fam_account_deletion_requests SET status = 'approved', reviewed_by = ${reviewerId},
            reviewed_at = CurrentUtcTimestamp(), review_note = ${reviewNote}
            WHERE request_id = ${preserveRequestId} AND school_id = ${schoolId} AND status = 'processing';`;
          await tx`DELETE FROM fam_account_deletion_open WHERE target_id = ${userId} AND request_id = ${preserveRequestId} AND school_id = ${schoolId};`;
        }
        const deletionRows = await tx`SELECT target_id, request_id FROM fam_account_deletion_requests
          WHERE requester_id = ${userId} OR target_id = ${userId};`;
        for (const item of deletionRows?.[0] ?? []) {
          if (item.request_id === preserveRequestId) continue;
          await tx`DELETE FROM fam_account_deletion_open WHERE target_id = ${item.target_id} AND request_id = ${item.request_id};`;
          await tx`DELETE FROM fam_account_deletion_requests WHERE request_id = ${item.request_id};`;
        }

        await tx`DELETE FROM fam_favorites WHERE user_id = ${userId};`;
        await tx`DELETE FROM fam_idea_images WHERE user_id = ${userId};`;
        await tx`DELETE FROM fam_ideas WHERE user_id = ${userId};`;
        await tx`DELETE FROM fam_messages WHERE sender_id = ${userId} OR receiver_id = ${userId};`;
        await tx`DELETE FROM fam_pending_messages WHERE sender_id = ${userId} OR receiver_id = ${userId};`;
        await tx`DELETE FROM fam_profile_requests WHERE issuer = ${issuer} AND subject = ${subject};`;
        await tx`DELETE FROM fam_school_role_requests WHERE issuer = ${issuer} AND subject = ${subject};`;
        await tx`UPDATE fam_school_role_requests SET reviewed_by = NULL WHERE reviewed_by = ${userId};`;
        await tx`DELETE FROM fam_school_role_request_audit WHERE actor_id = ${userId};`;
        await tx`DELETE FROM fam_account_suspensions WHERE target_id = ${userId};`;
        await tx`UPDATE fam_account_suspensions SET issued_by = 'deleted-account' WHERE issued_by = ${userId};`;
        await tx`DELETE FROM fam_account_suspension_open WHERE target_id = ${userId};`;
        await tx`DELETE FROM fam_account_suspension_audit WHERE target_id = ${userId} OR actor_id = ${userId};`;
        await tx`UPDATE fam_account_deletion_requests SET reviewed_by = NULL WHERE reviewed_by = ${userId};`;
        await tx`DELETE FROM fam_school_admin_audit WHERE target_id = ${userId} OR actor_id = ${userId};`;
        await tx`DELETE FROM fam_school_announcements WHERE author_id = ${userId};`;
        await tx`DELETE FROM fam_school_poll_votes WHERE voter_id = ${userId};`;
        await tx`DELETE FROM fam_avatar_reviews WHERE user_id = ${userId};`;
        await tx`DELETE FROM fam_pending_media WHERE user_id = ${userId};`;
        await tx`DELETE FROM fam_notification_reads WHERE user_id = ${userId};`;
        await tx`DELETE FROM fam_submission_quotas WHERE user_id = ${userId};`;
        await tx`UPDATE fam_school_content_audit SET actor_id = 'deleted-account' WHERE actor_id = ${userId};`;
        await tx`UPDATE fam_safety_incidents SET actor_id = CAST(NULL AS Utf8?), target_id = CAST(NULL AS Utf8?),
          source_origin = CAST(NULL AS Utf8?), evidence_excerpt = CAST(NULL AS Utf8?)
          WHERE actor_id = ${userId} OR target_id = ${userId};`;
        if (adminAudit) await tx`INSERT INTO fam_school_admin_audit
          (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${adminAudit.actorId}, ${userId}, 'account_deleted', ${adminAudit.targetRole}, CurrentUtcTimestamp());`;
        await tx`DELETE FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} AND user_id = ${userId} AND active = false;`;
        await tx`DELETE FROM fam_account_deletion_jobs WHERE user_id = ${userId} AND claim_token = ${claimToken};`;
        return { ok: true, deleted: true };
      });
    },

    async createSchoolProfileRequest(record) {
      const personType = record?.person_type ?? 'student';
      const staffPosition = record?.staff_position ?? '';
      if (!record?.issuer || !record?.subject || !record?.school_id || !record?.first_name || !record?.last_name
          || !['student', 'school_staff', 'parent'].includes(personType)
          || (personType === 'student' && !record.class_name)
          || (personType === 'school_staff' && !staffPosition)) {
        throw new TypeError('invalid school profile request');
      }
      const requestId = randomUUID();
      return sql.begin(async tx => {
        const existingProfile = await tx`SELECT user_id FROM fam_user_profiles
          WHERE issuer = ${record.issuer} AND subject = ${record.subject} LIMIT 1;`;
        if (existingProfile?.[0]?.length) return { ok: false, code: 'profile_exists' };
        const existingRequest = await tx`SELECT request_id, status FROM fam_profile_requests
          WHERE issuer = ${record.issuer} AND subject = ${record.subject} LIMIT 1;`;
        const current = existingRequest?.[0]?.[0];
        if (current?.status === 'pending') return { ok: true, status: 'pending', request_id: current.request_id };
        await tx`UPSERT INTO fam_profile_requests
          (issuer, subject, request_id, school_id, first_name, last_name, class_name, person_type, staff_position, status, reviewed_by, created_at)
          VALUES (${record.issuer}, ${record.subject}, ${requestId}, ${record.school_id}, ${record.first_name}, ${record.last_name}, ${record.class_name ?? ''}, ${personType}, ${staffPosition}, 'pending', '', CurrentUtcTimestamp());`;
        return { ok: true, status: 'pending', request_id: requestId };
      });
    },

    async getSchoolProfileRequest(issuer, subject) {
      if (!issuer || !subject) throw new TypeError('invalid school profile request identity');
      const statement = sql`SELECT request_id AS request_id, school_id AS school_id,
          status AS status, created_at AS created_at
        FROM fam_profile_requests WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0]?.[0] ?? null;
    },

    async listPendingSchoolProfileRequests(schoolId) {
      if (!schoolId) throw new TypeError('invalid profile request school');
      const statement = sql`SELECT request_id AS request_id, school_id AS school_id,
          first_name AS first_name, last_name AS last_name, class_name AS class_name,
          person_type AS person_type, staff_position AS staff_position, created_at AS created_at
        FROM fam_profile_requests WHERE school_id = ${schoolId} AND status = 'pending'
        ORDER BY created_at ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async listPendingSchoolStaffVerifications(schoolId) {
      if (!schoolId) throw new TypeError('invalid staff verification school');
      const statement = sql`SELECT user_id AS user_id, first_name AS first_name, last_name AS last_name,
          staff_position AS staff_position
        FROM fam_user_profiles WHERE school_id = ${schoolId} AND person_type = 'school_staff'
          AND staff_verification_status = 'pending' AND active = true
        ORDER BY first_name ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async reviewSchoolStaffVerification({ userId, schoolId, reviewerId, decision }) {
      if (!userId || !schoolId || !reviewerId || !['approved', 'rejected'].includes(decision)) throw new TypeError('invalid staff verification decision');
      return sql.begin(async tx => {
        const admins = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const admin = admins?.[0]?.[0];
        if (!admin || !admin.active || admin.role !== 'school_admin' || admin.school_id !== schoolId) return false;
        const targets = await tx`SELECT school_id, person_type, staff_verification_status FROM fam_user_profiles
          WHERE user_id = ${userId} AND active = true LIMIT 1;`;
        const target = targets?.[0]?.[0];
        if (!target || target.school_id !== schoolId || target.person_type !== 'school_staff'
            || target.staff_verification_status !== 'pending') return false;
        await tx`UPDATE fam_user_profiles SET staff_verification_status = ${decision}
          WHERE user_id = ${userId} AND school_id = ${schoolId} AND person_type = 'school_staff'
            AND staff_verification_status = 'pending' AND active = true;`;
        await tx`INSERT INTO fam_school_admin_audit (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${reviewerId}, ${userId}, ${decision === 'approved' ? 'staff_verification_approved' : 'staff_verification_rejected'}, 'pending', CurrentUtcTimestamp());`;
        return true;
      });
    },

    async reviewSchoolProfileRequest(requestId, schoolId, reviewerId, decision) {
      if (!requestId || !schoolId || !reviewerId || !['approve', 'reject'].includes(decision)) throw new TypeError('invalid profile request decision');
      return sql.begin(async tx => {
        const requests = await tx`SELECT issuer, subject, school_id, first_name, last_name, class_name, person_type, staff_position, status
          FROM fam_profile_requests WHERE request_id = ${requestId} LIMIT 1;`;
        const request = requests?.[0]?.[0];
        if (!request || request.school_id !== schoolId || request.status !== 'pending') return false;
        if (decision === 'approve') {
          const profile = await tx`SELECT user_id FROM fam_user_profiles
            WHERE issuer = ${request.issuer} AND subject = ${request.subject} LIMIT 1;`;
          if (profile?.[0]?.length) return false;
          await tx`INSERT INTO fam_user_profiles
            (issuer, subject, user_id, school_id, role, active, first_name, last_name, class_name,
             person_type, staff_position, staff_verification_status)
            VALUES (${request.issuer}, ${request.subject}, ${randomUUID()}, ${schoolId}, 'student', true,
              ${request.first_name}, ${request.last_name}, ${request.class_name}, ${request.person_type},
              ${request.staff_position}, ${request.person_type === 'school_staff' ? 'pending' : 'not_required'});`;
        }
        const status = decision === 'approve' ? 'approved' : 'rejected';
        await tx`UPDATE fam_profile_requests SET status = ${status}, reviewed_by = ${reviewerId}, first_name = '',
            last_name = '', class_name = '', staff_position = '' WHERE issuer = ${request.issuer} AND subject = ${request.subject}
            AND request_id = ${requestId} AND school_id = ${schoolId} AND status = 'pending';`;
        const confirmed = await tx`SELECT status FROM fam_profile_requests WHERE issuer = ${request.issuer}
          AND subject = ${request.subject} AND request_id = ${requestId} LIMIT 1;`;
        return confirmed?.[0]?.[0]?.status === status;
      });
    },

    async createListing(record) {
      if (!record || record.status !== 'pending' || !record.user_id || !record.school_id) throw new TypeError('invalid pending listing');
      if (!Number.isInteger(record.max_seats) || record.max_seats < 0 || record.max_seats > 500) throw new TypeError('invalid max_seats');
      const id = randomUUID();
      const insertListing = tx => tx`INSERT INTO fam_listings
          (id, user_id, school_id, title, description, category, price_text, is_event,
           event_date, event_time, event_type, max_seats, image_key, photo_status, status, created_at)
          VALUES (${id}, ${record.user_id}, ${record.school_id}, ${record.title}, ${record.description},
            ${record.category}, ${record.price_text}, ${record.is_event}, ${record.event_date ?? ''},
            ${record.event_time ?? ''}, ${record.event_type ?? ''}, Unwrap(CAST(${record.max_seats} AS Uint32)),
            ${record.image_key ?? ''}, ${record.photo_status ?? 'none'},
            ${record.status}, CurrentUtcTimestamp());`;
      return sql.begin(async tx => {
        if (!await consumeSubmissionQuota(tx, record.user_id, 'listing', 5)) return { ok: false, code: 'rate_limited' };
        if (record.image_key) {
          const pending = await tx`SELECT user_id, status FROM fam_pending_media
            WHERE object_key = ${record.image_key} AND created_at > CurrentUtcTimestamp() - Interval('P7D') LIMIT 1;`;
          const upload = pending?.[0]?.[0];
          if (!upload || upload.user_id !== record.user_id || upload.status !== 'pending') {
            const error = new Error('pending image is unavailable'); error.code = 'pending_image_unavailable'; throw error;
          }
          await insertListing(tx);
          await tx`UPDATE fam_pending_media SET status = 'linked' WHERE object_key = ${record.image_key}
            AND user_id = ${record.user_id} AND status = 'pending';`;
        } else {
          await insertListing(tx);
        }
        return { id };
      });
    },

    async registerPendingImage(userId, objectKey) {
      if (typeof userId !== 'string' || !UUID.test(userId) || typeof objectKey !== 'string'
          || !new RegExp(`^pending/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i').test(objectKey)) {
        throw new TypeError('invalid pending image registration');
      }
      const statement = sql`INSERT INTO fam_pending_media (object_key, user_id, created_at, status, claim_token, claim_until)
        VALUES (${objectKey}, ${userId}, CurrentUtcTimestamp(), 'pending', '', CurrentUtcTimestamp());`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      await statement;
      return true;
    },

    async reserveImageUpload(userId) {
      if (typeof userId !== 'string' || !UUID.test(userId)) throw new TypeError('invalid image uploader');
      return sql.begin(async tx => {
        return consumeSubmissionQuota(tx, userId, 'image_upload', 5);
      });
    },

    async claimPendingImageDeletion(userId, objectKey) {
      if (typeof userId !== 'string' || !UUID.test(userId) || typeof objectKey !== 'string'
          || !new RegExp(`^pending/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i').test(objectKey)) {
        throw new TypeError('invalid pending image deletion request');
      }
      return sql.begin(async tx => {
        const rows = await tx`SELECT status FROM fam_pending_media WHERE object_key = ${objectKey}
          AND user_id = ${userId} LIMIT 1;`;
        if (rows?.[0]?.[0]?.status !== 'pending') return null;
        const linked = await tx`SELECT id FROM fam_listings WHERE image_key = ${objectKey} LIMIT 1;`;
        if (linked?.[0]?.length) return null;
        const token = randomUUID();
        await tx`UPDATE fam_pending_media SET status = 'deleting', claim_token = ${token},
            claim_until = Unwrap(CurrentUtcTimestamp() + Interval('PT5M'))
          WHERE object_key = ${objectKey} AND user_id = ${userId} AND status = 'pending';`;
        const claimed = await tx`SELECT claim_token FROM fam_pending_media WHERE object_key = ${objectKey}
          AND status = 'deleting' AND claim_token = ${token} LIMIT 1;`;
        return claimed?.[0]?.[0]?.claim_token ?? null;
      });
    },

    async claimExpiredPendingIm…3096 tokens truncated…ND user_id = ${record.user_id} LIMIT 1;`;
          if (owned?.[0]?.[0]?.status !== 'pending') throw new TypeError('idea image unavailable');
        }
        await tx`INSERT INTO fam_ideas
          (id, user_id, school_id, text, image_status, ai_status, ai_summary, ai_reason, admin_status, created_at)
          VALUES (${id}, ${record.user_id}, ${record.school_id}, ${record.text}, ${imageStatus}, ${record.ai_status},
            ${record.ai_summary ?? ''}, ${record.ai_reason ?? ''}, ${record.admin_status}, CurrentUtcTimestamp());`;
        for (const [imageIndex, key] of imageKeys.entries()) {
          await tx`INSERT INTO fam_idea_images
            (idea_id, image_index, object_key, user_id, school_id, created_at)
            VALUES (${id}, Unwrap(CAST(${imageIndex} AS Uint32)), ${key}, ${record.user_id}, ${record.school_id}, CurrentUtcTimestamp());`;
          await tx`UPDATE fam_pending_media SET status = 'linked', claim_token = '', claim_until = CurrentUtcTimestamp()
            WHERE object_key = ${key} AND user_id = ${record.user_id} AND status = 'pending';`;
        }
        return { id };
      });
    },

    async listPendingSchoolIdeas(schoolId, reviewerId, reviewerRole) {
      if (!schoolId || !UUID.test(reviewerId || '') || !['school_admin', 'council_member'].includes(reviewerRole)) throw new TypeError('invalid idea review school');
      const statement = reviewerRole === 'school_admin'
        ? sql`SELECT id, school_id, user_id, text, image_status, ai_status, created_at
          FROM fam_ideas WHERE school_id = ${schoolId} AND user_id != ${reviewerId} AND admin_status = 'new' AND ai_status != 'rejected'
          ORDER BY created_at DESC LIMIT 50;`
        : sql`SELECT id, school_id, user_id, text, image_status, ai_status, created_at
          FROM fam_ideas WHERE school_id = ${schoolId} AND user_id != ${reviewerId} AND admin_status = 'new' AND ai_status = 'approved'
          ORDER BY created_at DESC LIMIT 50;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const ideas = (await statement)?.[0] ?? [];
      return Promise.all(ideas.map(async idea => {
        const images = await sql`SELECT object_key FROM fam_idea_images WHERE idea_id = ${idea.id}
          AND user_id = ${idea.user_id} AND school_id = ${idea.school_id}
          ORDER BY image_index ASC LIMIT 3;`;
        const { user_id: _userId, ...safeIdea } = idea;
        return { ...safeIdea, image_keys: (images?.[0] ?? []).map(image => image.object_key) };
      }));
    },

    async listSchoolIdeaWorkflow(schoolId, reviewerId) {
      if (typeof schoolId !== 'string' || !schoolId || !UUID.test(reviewerId || '')) throw new TypeError('invalid idea workflow school');
      const statement = sql`SELECT id, text, admin_status, created_at, user_id = ${reviewerId} AS is_own
        FROM fam_ideas WHERE school_id = ${schoolId} AND ai_status = 'approved'
        ORDER BY created_at DESC LIMIT 200;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async updateSchoolIdeaWorkflow({ ideaId, schoolId, reviewerId, status }) {
      if (!UUID.test(ideaId || '') || typeof schoolId !== 'string' || !schoolId || !UUID.test(reviewerId || '')
          || !['in_progress', 'done', 'rejected'].includes(status)) throw new TypeError('invalid idea workflow update');
      return sql.begin(async tx => {
        const reviewers = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewers?.[0]?.[0];
        if (!reviewer || reviewer.school_id !== schoolId || reviewer.active !== true || !['school_admin', 'council_member'].includes(reviewer.role)) return false;
        const rows = await tx`SELECT admin_status FROM fam_ideas WHERE id = ${ideaId} AND school_id = ${schoolId} AND ai_status = 'approved' LIMIT 1;`;
        const idea = rows?.[0]?.[0];
        const allowed = idea?.admin_status === 'new' ? ['in_progress', 'rejected']
          : idea?.admin_status === 'in_progress' ? ['done', 'rejected'] : [];
        if (!idea || !allowed.includes(status)) return false;
        await tx`UPDATE fam_ideas SET admin_status = ${status}
          WHERE id = ${ideaId} AND school_id = ${schoolId} AND ai_status = 'approved' AND admin_status = ${idea.admin_status};`;
        await tx`INSERT INTO fam_school_content_audit
          (event_id, school_id, actor_id, entity_id, entity_type, action, details, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${reviewerId}, ${ideaId}, 'idea', ${`idea_workflow_${status}`}, '{}', CurrentUtcTimestamp());`;
        return true;
      });
    },

    async listOwnIdeas(userId, schoolId) {
      if (!UUID.test(userId || '') || typeof schoolId !== 'string' || !schoolId) throw new TypeError('invalid own idea lookup');
      const statement = sql`SELECT id, text, image_status, ai_status, admin_status, created_at
        FROM fam_ideas WHERE user_id = ${userId} AND school_id = ${schoolId}
        ORDER BY created_at DESC LIMIT 50;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const ideas = (await statement)?.[0] ?? [];
      return Promise.all(ideas.map(async idea => {
        const images = await sql`SELECT image_index FROM fam_idea_images
          WHERE idea_id = ${idea.id} AND user_id = ${userId} AND school_id = ${schoolId}
          ORDER BY image_index ASC LIMIT 3;`;
        return { ...idea, image_count: (images?.[0] ?? []).length };
      }));
    },

    async getSchoolIdeaDeletionContext({ ideaId, schoolId }) {
      if (!UUID.test(ideaId || '') || typeof schoolId !== 'string' || !schoolId) throw new TypeError('invalid school idea deletion lookup');
      const statement = sql`SELECT user_id, school_id FROM fam_ideas WHERE id = ${ideaId} AND school_id = ${schoolId} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0]?.[0] ?? null;
    },

    async deleteSchoolIdea({ ideaId, actorId, schoolId }) {
      if (!UUID.test(ideaId || '') || !UUID.test(actorId || '') || typeof schoolId !== 'string' || !schoolId) {
        throw new TypeError('invalid school idea deletion');
      }
      return sql.begin(async tx => {
        const actors = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${actorId} LIMIT 1;`;
        const actor = actors?.[0]?.[0];
        if (!actor || actor.active !== true || actor.school_id !== schoolId) return { ok: false, code: 'forbidden' };
        const ideas = await tx`SELECT id, user_id, school_id FROM fam_ideas WHERE id = ${ideaId} AND school_id = ${schoolId} LIMIT 1;`;
        const idea = ideas?.[0]?.[0];
        if (!idea) return { ok: false, code: 'idea_unavailable' };
        const own = idea.user_id === actorId;
        if (!own && actor.role !== 'school_admin') return { ok: false, code: 'forbidden' };

        const imageRows = await tx`SELECT image_index, object_key FROM fam_idea_images
          WHERE idea_id = ${ideaId} AND user_id = ${idea.user_id} AND school_id = ${schoolId}
          ORDER BY image_index ASC LIMIT 3;`;
        const mediaCleanup = [];
        for (const image of imageRows?.[0] ?? []) {
          if (typeof image.object_key !== 'string'
              || image.object_key !== `pending/${idea.user_id}/${image.object_key.split('/').at(-1)}`
              || !/^pending\/[0-9a-f-]{36}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i.test(image.object_key)) {
            return { ok: false, code: 'idea_media_unavailable' };
          }
          const mediaRows = await tx`SELECT status FROM fam_pending_media WHERE object_key = ${image.object_key}
            AND user_id = ${idea.user_id} LIMIT 1;`;
          if (mediaRows?.[0]?.[0]?.status !== 'linked') return { ok: false, code: 'idea_media_unavailable' };
          const claimToken = randomUUID();
          await tx`UPDATE fam_pending_media SET status = 'deleting', claim_token = ${claimToken},
            claim_until = Unwrap(CurrentUtcTimestamp() + Interval('PT5M'))
            WHERE object_key = ${image.object_key} AND user_id = ${idea.user_id} AND status = 'linked';`;
          mediaCleanup.push({ object_key: image.object_key, claim_token: claimToken });
        }
        await tx`DELETE FROM fam_idea_images WHERE idea_id = ${ideaId} AND user_id = ${idea.user_id} AND school_id = ${schoolId};`;
        await tx`DELETE FROM fam_ideas WHERE id = ${ideaId} AND school_id = ${schoolId};`;
        if (!own) {
          await tx`INSERT INTO fam_school_content_audit
            (event_id, school_id, actor_id, entity_id, entity_type, action, details, created_at)
            VALUES (${randomUUID()}, ${schoolId}, ${actorId}, ${ideaId}, 'idea', 'idea_deleted', '{}', CurrentUtcTimestamp());`;
        }
        return { ok: true, own, media_cleanup: mediaCleanup };
      });
    },

    async getSchoolIdeaImage(ideaId, imageIndex) {
      if (!UUID.test(ideaId || '') || !Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 2) throw new TypeError('invalid idea image lookup');
      const statement = sql`SELECT user_id, school_id, image_status, ai_status FROM fam_ideas WHERE id = ${ideaId} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const row = (await statement)?.[0]?.[0];
      if (!row || !['pending', 'approved'].includes(row.image_status)) return null;
      const imageStatement = sql`SELECT object_key FROM fam_idea_images WHERE idea_id = ${ideaId}
        AND user_id = ${row.user_id} AND school_id = ${row.school_id}
        AND image_index = Unwrap(CAST(${imageIndex} AS Uint32)) LIMIT 1;`;
      if (typeof imageStatement?.on === 'function') imageStatement.on('error', () => {});
      const image = (await imageStatement)?.[0]?.[0];
      if (!image?.object_key) return null;
      return { user_id: row.user_id, school_id: row.school_id, image_key: image.object_key, image_status: row.image_status, ai_status: row.ai_status };
    },

    async reviewSchoolIdeaImages({ ideaId, schoolId, reviewerId, decision }) {
      if (!UUID.test(ideaId || '') || !schoolId || !UUID.test(reviewerId || '') || !['approve', 'reject'].includes(decision)) throw new TypeError('invalid idea image review');
      return sql.begin(async tx => {
        const reviewers = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewers?.[0]?.[0];
        if (!reviewer || reviewer.school_id !== schoolId || reviewer.active !== true || !['school_admin', 'council_member'].includes(reviewer.role)) return false;
        const rows = await tx`SELECT user_id, image_status, ai_status FROM fam_ideas WHERE id = ${ideaId} AND school_id = ${schoolId} LIMIT 1;`;
        const idea = rows?.[0]?.[0];
        if (!idea || idea.user_id === reviewerId || idea.image_status !== 'pending') return false;
        if (reviewer.role === 'council_member' && idea.ai_status !== 'approved') return false;
        const imageRows = await tx`SELECT image_index, object_key FROM fam_idea_images WHERE idea_id = ${ideaId}
          AND user_id = ${idea.user_id} AND school_id = ${schoolId}
          ORDER BY image_index ASC LIMIT 3;`;
        const images = imageRows?.[0] ?? [];
        if (!images.length) return false;
        if (decision === 'approve') {
          await tx`UPDATE fam_ideas SET image_status = 'approved' WHERE id = ${ideaId} AND school_id = ${schoolId} AND image_status = 'pending';`;
        } else {
          for (const image of images) {
            await tx`UPDATE fam_pending_media SET status = 'pending', claim_token = '', claim_until = CurrentUtcTimestamp()
              WHERE object_key = ${image.object_key} AND user_id = ${idea.user_id} AND status = 'linked';`;
            await tx`DELETE FROM fam_idea_images WHERE idea_id = ${ideaId}
              AND image_index = ${image.image_index} AND user_id = ${idea.user_id} AND school_id = ${schoolId};`;
          }
          await tx`UPDATE fam_ideas SET image_status = 'rejected' WHERE id = ${ideaId} AND school_id = ${schoolId} AND image_status = 'pending';`;
        }
        return true;
      });
    },

    async reviewSchoolIdeaText({ ideaId, schoolId, reviewerId, decision }) {
      if (!UUID.test(ideaId || '') || !schoolId || !UUID.test(reviewerId || '') || !['approve', 'reject'].includes(decision)) throw new TypeError('invalid idea text review');
      return sql.begin(async tx => {
        const reviewers = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewers?.[0]?.[0];
        if (!reviewer || reviewer.school_id !== schoolId || reviewer.active !== true || reviewer.role !== 'school_admin') return false;
        const rows = await tx`SELECT user_id, ai_status, image_status FROM fam_ideas WHERE id = ${ideaId} AND school_id = ${schoolId} LIMIT 1;`;
        const idea = rows?.[0]?.[0];
        if (!idea || idea.user_id === reviewerId || idea.ai_status !== 'pending') return false;
        const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
        if (decision === 'reject' && ['pending', 'approved'].includes(idea.image_status)) {
          const imageRows = await tx`SELECT image_index, object_key FROM fam_idea_images WHERE idea_id = ${ideaId}
            AND user_id = ${idea.user_id} AND school_id = ${schoolId} ORDER BY image_index ASC LIMIT 3;`;
          for (const image of imageRows?.[0] ?? []) {
            await tx`UPDATE fam_pending_media SET status = 'pending', claim_token = '', claim_until = CurrentUtcTimestamp()
              WHERE object_key = ${image.object_key} AND user_id = ${idea.user_id} AND status = 'linked';`;
            await tx`DELETE FROM fam_idea_images WHERE idea_id = ${ideaId} AND image_index = ${image.image_index}
              AND user_id = ${idea.user_id} AND school_id = ${schoolId};`;
          }
          await tx`UPDATE fam_ideas SET ai_status = ${nextStatus}, image_status = 'rejected' WHERE id = ${ideaId} AND school_id = ${schoolId} AND ai_status = 'pending';`;
        } else {
          await tx`UPDATE fam_ideas SET ai_status = ${nextStatus} WHERE id = ${ideaId} AND school_id = ${schoolId} AND ai_status = 'pending';`;
        }
        await tx`INSERT INTO fam_school_content_audit
          (event_id, school_id, actor_id, entity_id, entity_type, action, details, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${reviewerId}, ${ideaId}, 'idea', ${decision === 'approve' ? 'idea_text_approved' : 'idea_text_rejected'}, '{}', CurrentUtcTimestamp());`;
        return true;
      });
    },

    async createMessage(record) {
      if (!record || !record.sender_id || !record.receiver_id || !record.school_id
          || typeof record.body !== 'string' || !record.body.trim() || record.body.length > 1000
          || record.sender_id === record.receiver_id) throw new TypeError('invalid message');
      const id = randomUUID();
      return sql.begin(async tx => {
        const recipients = await tx`SELECT user_id AS user_id FROM fam_user_profiles
          WHERE user_id = ${record.receiver_id} AND school_id = ${record.school_id} AND active = true LIMIT 1;`;
        if (!(recipients?.[0] ?? []).length) return { ok: false, code: 'recipient_unavailable' };
        if (!await consumeRollingSubmissionQuota(tx, record.sender_id, 'message', 8)) {
          return { ok: false, code: 'rate_limited' };
        }
        await tx`INSERT INTO fam_messages (id, sender_id, receiver_id, school_id, listing_id, body, is_read, created_at)
          VALUES (${id}, ${record.sender_id}, ${record.receiver_id}, ${record.school_id}, ${record.listing_id ?? ''}, ${record.body}, false, CurrentUtcTimestamp());`;
        return { id };
      });
    },

    async createPendingMessage(record) {
      if (!record || !record.sender_id || !record.receiver_id || !record.school_id
          || typeof record.body !== 'string' || !record.body.trim() || record.body.length > 1000
          || record.sender_id === record.receiver_id) throw new TypeError('invalid pending message');
      const id = randomUUID();
      return sql.begin(async tx => {
        const participants = await tx`SELECT user_id, school_id, active FROM fam_user_profiles
          WHERE (user_id = ${record.sender_id} OR user_id = ${record.receiver_id}) AND school_id = ${record.school_id};`;
        const byId = new Map((participants?.[0] ?? []).map(row => [row.user_id, row]));
        if (byId.get(record.sender_id)?.active !== true) throw new Error('sender unavailable');
        if (byId.get(record.receiver_id)?.active !== true) {
          const error = new Error('recipient unavailable'); error.code = 'recipient_unavailable'; throw error;
        }
        if (!await consumeRollingSubmissionQuota(tx, record.sender_id, 'message', 8)) {
          const error = new Error('message rate limit'); error.code = 'rate_limited'; throw error;
        }
        await tx`INSERT INTO fam_pending_messages (id, sender_id, receiver_id, school_id, listing_id, body, created_at)
          VALUES (${id}, ${record.sender_id}, ${record.receiver_id}, ${record.school_id}, ${record.listing_id ?? ''}, ${record.body}, CurrentUtcTimestamp());`;
        return { id };
      });
    },

    async listPendingMessages(schoolId) {
      if (!schoolId) throw new TypeError('invalid pending message school');
      const cleanup = sql`DELETE FROM fam_pending_messages WHERE school_id = ${schoolId}
        AND created_at < CurrentUtcTimestamp() - Interval('P30D');`;
      if (typeof cleanup?.on === 'function') cleanup.on('error', () => {});
      await cleanup;
      const statement = sql`SELECT id, sender_id, body, created_at FROM fam_pending_messages
        WHERE school_id = ${schoolId} ORDER BY created_at ASC LIMIT 50;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async decidePendingMessage({ messageId, schoolId, reviewerId, decision }) {
      if (!messageId || !schoolId || !reviewerId || !['approve', 'reject'].includes(decision)) throw new TypeError('invalid pending message decision');
      return sql.begin(async tx => {
        const reviewers = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewers?.[0]?.[0];
        if (!reviewer || reviewer.active !== true || reviewer.role !== 'school_admin' || reviewer.school_id !== schoolId) return false;
        const rows = await tx`SELECT id, sender_id, receiver_id, school_id, listing_id, body FROM fam_pending_messages
          WHERE id = ${messageId} AND school_id = ${schoolId} LIMIT 1;`;
        const pending = rows?.[0]?.[0];
        if (!pending) return false;
        if (decision === 'approve') {
          const participants = await tx`SELECT user_id, school_id, active FROM fam_user_profiles
            WHERE (user_id = ${pending.sender_id} OR user_id = ${pending.receiver_id}) AND school_id = ${schoolId};`;
          const activeIds = new Set((participants?.[0] ?? []).filter(row => row.school_id === schoolId && row.active === true).map(row => row.user_id));
          if (!activeIds.has(pending.sender_id) || !activeIds.has(pending.receiver_id)) return false;
          await tx`INSERT INTO fam_messages (id, sender_id, receiver_id, school_id, listing_id, body, is_read, created_at)
            VALUES (${pending.id}, ${pending.sender_id}, ${pending.receiver_id}, ${schoolId}, ${pending.listing_id ?? ''}, ${pending.body}, false, CurrentUtcTimestamp());`;
        }
        await tx`DELETE FROM fam_pending_messages WHERE id = ${messageId} AND school_id = ${schoolId};`;
        await tx`INSERT INTO fam_school_admin_audit (event_id, school_id, actor_id, target_id, action, previous_role, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${reviewerId}, ${pending.sender_id}, ${decision === 'approve' ? 'message_approved' : 'message_rejected'}, '', CurrentUtcTimestamp());`;
        return true;
      });
    },

    async getListingContactRecipient(listingId, senderId, schoolId) {
      if (!listingId || !senderId || !schoolId) throw new TypeError('invalid listing contact');
      const statement = sql`SELECT user_id AS user_id FROM fam_listings
        WHERE id = ${listingId} AND school_id = ${schoolId} AND status = 'active'
          AND user_id != ${senderId} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0]?.[0]?.user_id ?? null;
    },

    async listMessages(userId, schoolId) {
      if (!userId || !schoolId) throw new TypeError('invalid message owner');
      const statement = sql`SELECT id, sender_id, receiver_id, listing_id, body, is_read, created_at FROM fam_messages
        WHERE school_id = ${schoolId} AND (sender_id = ${userId} OR receiver_id = ${userId})
        ORDER BY created_at DESC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const sets = await statement;
      return sets?.[0] ?? [];
    },

    async markMessageRead(userId, schoolId, messageId) {
      if (!userId || !schoolId || !messageId) throw new TypeError('invalid message owner');
      const update = sql`UPDATE fam_messages SET is_read = true WHERE id = ${messageId}
        AND receiver_id = ${userId} AND school_id = ${schoolId};`;
      if (typeof update?.on === 'function') update.on('error', () => {});
      await update;
      const confirmed = sql`SELECT id FROM fam_messages WHERE id = ${messageId}
        AND receiver_id = ${userId} AND school_id = ${schoolId} LIMIT 1;`;
      if (typeof confirmed?.on === 'function') confirmed.on('error', () => {});
      return Boolean((await confirmed)?.[0]?.length);
    },

    async markMessagesRead(userId, schoolId, messageIds) {
      if (!userId || !schoolId || !Array.isArray(messageIds) || messageIds.length > 100
          || messageIds.some(id => !UUID.test(id || ''))) throw new TypeError('invalid message read batch');
      const ids = [...new Set(messageIds)];
      return sql.begin(async tx => {
        let updated = 0;
        for (const id of ids) {
          const owned = await tx`SELECT receiver_id, school_id FROM fam_messages WHERE id = ${id} LIMIT 1;`;
          const message = owned?.[0]?.[0];
          if (message?.receiver_id !== userId || message?.school_id !== schoolId) continue;
          await tx`UPDATE fam_messages SET is_read = true WHERE id = ${id} AND receiver_id = ${userId} AND school_id = ${schoolId};`;
          updated += 1;
        }
        return updated;
      });
    },

    async listFavoriteIds(userId) {
      if (typeof userId !== 'string' || !userId) throw new TypeError('invalid user id');
      const statement = sql`SELECT f.listing_id AS listing_id FROM fam_favorites AS f
        INNER JOIN fam_listings AS l ON f.listing_id = l.id
        WHERE f.user_id = ${userId} AND l.status = 'active';`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const resultSets = await statement;
      return (resultSets?.[0] ?? []).map(row => row.listing_id);
    },

    async setFavorite(userId, listingId, favorite) {
      if (typeof userId !== 'string' || !userId || typeof listingId !== 'string' || !listingId || typeof favorite !== 'boolean') {
        throw new TypeError('invalid favorite request');
      }
      if (favorite) {
        const active = sql`SELECT id FROM fam_listings WHERE id = ${listingId} AND status = 'active' LIMIT 1;`;
        if (typeof active?.on === 'function') active.on('error', () => {});
        const rows = await active;
        if (!(rows?.[0] ?? []).length) return false;
        const insert = sql`UPSERT INTO fam_favorites (user_id, listing_id, created_at)
          VALUES (${userId}, ${listingId}, CurrentUtcTimestamp());`;
        if (typeof insert?.on === 'function') insert.on('error', () => {});
        await insert;
        return true;
      }
      const remove = sql`DELETE FROM fam_favorites WHERE user_id = ${userId} AND listing_id = ${listingId};`;
      if (typeof remove?.on === 'function') remove.on('error', () => {});
      await remove;
      return true;
    },

    async listOwnActiveListingIds(userId) {
      if (typeof userId !== 'string' || !userId) throw new TypeError('invalid listing owner');
      const statement = sql`SELECT id FROM fam_listings WHERE user_id = ${userId} AND status = 'active'
        ORDER BY created_at DESC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return ((await statement)?.[0] ?? []).map(row => row.id);
    },

    async listOwnListingSummaries(userId) {
      if (typeof userId !== 'string' || !userId) throw new TypeError('invalid listing owner');
      const statement = sql`SELECT id, title, description, category, price_text, is_event,
        event_date, event_time, event_type, max_seats, status, photo_status, created_at
        FROM fam_listings WHERE user_id = ${userId}
        ORDER BY created_at DESC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return ((await statement)?.[0] ?? []).map(row => ({
        id: row.id, title: row.title, description: row.description, category: row.category,
        price_text: row.price_text, is_event: Boolean(row.is_event), event_date: row.event_date || null,
        event_time: row.event_time || null, event_type: row.event_type || null,
        max_seats: Number(row.max_seats || 0), status: row.status,
        photo_status: row.photo_status || 'none', created_at: row.created_at,
      }));
    },

    async deleteOwnListing(userId, listingId) {
      if (typeof userId !== 'string' || !userId || typeof listingId !== 'string' || !UUID.test(listingId)) {
        throw new TypeError('invalid own listing deletion');
      }
      return sql.begin(async tx => {
        const rows = await tx`SELECT user_id, is_event, image_key FROM fam_listings WHERE id = ${listingId} LIMIT 1;`;
        const listing = rows?.[0]?.[0];
        if (!listing || listing.user_id !== userId) return null;

        if (listing.is_event) {
          await tx`DELETE FROM fam_event_registrations WHERE event_id = ${listingId};`;
          await tx`DELETE FROM fam_event_occupancy WHERE event_id = ${listingId};`;
        }
        await tx`DELETE FROM fam_favorites WHERE listing_id = ${listingId};`;

        let mediaCleanup = null;
        if (listing.image_key) {
          const mediaRows = await tx`SELECT status FROM fam_pending_media WHERE object_key = ${listing.image_key} LIMIT 1;`;
          if (mediaRows?.[0]?.[0]) {
            const claimToken = randomUUID();
            await tx`UPDATE fam_pending_media SET status = 'deleting', claim_token = ${claimToken},
                claim_until = Unwrap(CurrentUtcTimestamp() + Interval('PT5M'))
              WHERE object_key = ${listing.image_key};`;
            mediaCleanup = { object_key: listing.image_key, claim_token: claimToken };
          }
        }

        await tx`DELETE FROM fam_listings WHERE id = ${listingId} AND user_id = ${userId};`;
        return { id: listingId, media_cleanup: mediaCleanup };
      });
    },

    async getSchoolListingDeletionContext({ schoolId, actorId, listingId }) {
      if (!schoolId || !actorId || !UUID.test(listingId || '')) throw new TypeError('invalid school listing deletion lookup');
      const statement = sql`SELECT user_id, school_id, category FROM fam_listings WHERE id = ${listingId} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const listing = (await statement)?.[0]?.[0];
      if (!listing || listing.school_id !== schoolId) return null;
      return { user_id: listing.user_id, school_id: listing.school_id, category: listing.category };
    },

    async deleteSchoolListing({ schoolId, actorId, listingId }) {
      if (!schoolId || !actorId || !UUID.test(listingId || '')) throw new TypeError('invalid school listing deletion');
      return sql.begin(async tx => {
        const actorRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${actorId} LIMIT 1;`;
        const actor = actorRows?.[0]?.[0];
        if (!actor || actor.active !== true || actor.role !== 'school_admin' || actor.school_id !== schoolId) return { ok: false, code: 'forbidden' };
        const listingRows = await tx`SELECT id, user_id, school_id, category, is_event, image_key FROM fam_listings WHERE id = ${listingId} LIMIT 1;`;
        const listing = listingRows?.[0]?.[0];
        if (!listing || listing.school_id !== schoolId) return { ok: false, code: 'listing_unavailable' };

        if (listing.is_event === true) {
          await tx`DELETE FROM fam_event_registrations WHERE event_id = ${listingId};`;
          await tx`DELETE FROM fam_event_occupancy WHERE event_id = ${listingId};`;
        }
        await tx`DELETE FROM fam_favorites WHERE listing_id = ${listingId};`;

        let mediaCleanup = null;
        if (typeof listing.image_key === 'string' && UUID.test(listing.user_id || '')) {
          const keyParts = listing.image_key.split('/');
          const validOwnedKey = keyParts.length === 3 && keyParts[0] === 'pending'
            && keyParts[1].toLowerCase() === listing.user_id.toLowerCase()
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i.test(keyParts[2]);
          if (validOwnedKey) {
            const mediaRows = await tx`SELECT user_id FROM fam_pending_media WHERE object_key = ${listing.image_key} LIMIT 1;`;
            if (mediaRows?.[0]?.[0]?.user_id === listing.user_id) {
              const claimToken = randomUUID();
              await tx`UPDATE fam_pending_media SET status = 'deleting', claim_token = ${claimToken},
                claim_until = Unwrap(CurrentUtcTimestamp() + Interval('PT5M')) WHERE object_key = ${listing.image_key};`;
              const claim = await tx`SELECT object_key, claim_token FROM fam_pending_media
                WHERE object_key = ${listing.image_key} AND status = 'deleting' AND claim_token = ${claimToken} LIMIT 1;`;
              if (claim?.[0]?.[0]) mediaCleanup = claim[0][0];
            }
          }
        }

        await tx`DELETE FROM fam_listings WHERE id = ${listingId} AND school_id = ${schoolId};`;
        await tx`INSERT INTO fam_school_content_audit
          (event_id, school_id, actor_id, entity_id, entity_type, action, details, created_at)
          VALUES (${randomUUID()}, ${schoolId}, ${actorId}, ${listingId}, 'listing', 'listing_deleted',
            ${JSON.stringify({ category: String(listing.category ?? '').slice(0, 40), image_cleanup: mediaCleanup ? 'queued' : 'not_needed' })}, CurrentUtcTimestamp());`;
        return { ok: true, id: listingId, media_cleanup: mediaCleanup };
      });
    },

    async listActiveListings(schoolId) {
      if (typeof schoolId !== 'string' || !schoolId.trim()) throw new TypeError('school scope is required');
      const statement = sql`SELECT id, title, description, category, price_text, is_event,
        event_date, event_time, event_type, max_seats, created_at, image_key, photo_status
        FROM fam_listings
        WHERE school_id = ${schoolId} AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const resultSets = await statement;
      return (resultSets?.[0] ?? []).map(row => ({
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        price_text: row.price_text,
        is_event: row.is_event,
        event_date: row.event_date || null,
        event_time: row.event_time || null,
        event_type: row.event_type || null,
        max_seats: row.max_seats,
        created_at: row.created_at,
        photo_url: row.image_key && row.photo_status === 'approved' ? `/api/v1/listings/${row.id}/photo` : null,
      }));
    },

    async listPendingListings(schoolId) {
      if (!schoolId) throw new TypeError('invalid school id');
      const statement = sql`SELECT id, title, description, category, price_text, is_event,
        event_date, event_time, event_type, max_seats, created_at, image_key, photo_status
        FROM fam_listings
        WHERE school_id = ${schoolId} AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const resultSets = await statement;
      return (resultSets?.[0] ?? []).map(row => ({
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        price_text: row.price_text,
        is_event: row.is_event,
        event_date: row.event_date || null,
        event_time: row.event_time || null,
        event_type: row.event_type || null,
        max_seats: row.max_seats,
        created_at: row.created_at,
        photo_status: row.photo_status || 'none',
        photo_url: row.image_key ? `/api/v1/listings/${row.id}/photo` : null,
      }));
    },

    async getEventOccupancy(eventId) {
      if (!eventId) throw new TypeError('invalid event id');
      const statement = sql`SELECT taken FROM fam_event_occupancy WHERE event_id = ${eventId} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const rows = await statement;
      return Number(rows?.[0]?.[0]?.taken ?? 0);
    },


    async getPublicEventOccupancy(eventId, schoolId) {
      if (!eventId || typeof schoolId !== 'string' || !schoolId.trim()) throw new TypeError('event and school scope are required');
      const statement = sql`SELECT o.taken FROM fam_event_occupancy AS o
        INNER JOIN fam_listings AS l ON l.id = o.event_id
        WHERE o.event_id = ${eventId} AND l.school_id = ${schoolId} AND l.is_event = true AND l.status = 'active' LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const rows = await statement;
      const row = rows?.[0]?.[0];
      return row ? Number(row.taken ?? 0) : null;
    },
    async listEventRegistrations(userId) {
      if (!userId) throw new TypeError('invalid event registrant');
      const statement = sql`SELECT r.event_id AS event_id, r.user_id AS user_id, r.status AS status,
          r.created_at AS created_at, l.title AS event_title, l.event_date AS event_date,
          l.event_time AS event_time, l.event_type AS event_type
        FROM fam_event_registrations AS r
        INNER JOIN fam_listings AS l ON l.id = r.event_id
        WHERE r.user_id = ${userId}
        ORDER BY r.created_at DESC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async listEventApplicants(eventId, schoolId, viewerId) {
      if (!eventId || !schoolId || !viewerId) throw new TypeError('invalid event applicant scope');
      const statement = sql`SELECT r.user_id AS user_id, r.status AS status,
          r.created_at AS created_at, p.first_name AS first_name,
          p.last_name AS last_name, p.class_name AS class_name,
          p.person_type AS person_type, p.staff_position AS staff_position
        FROM fam_event_registrations AS r
        INNER JOIN fam_user_profiles AS p ON p.user_id = r.user_id AND p.school_id = r.school_id
        INNER JOIN fam_listings AS l ON l.id = r.event_id AND l.school_id = r.school_id
        WHERE r.event_id = ${eventId} AND r.school_id = ${schoolId}
          AND (l.user_id = ${viewerId} OR EXISTS (
            SELECT 1 FROM fam_user_profiles AS viewer
            WHERE viewer.user_id = ${viewerId} AND viewer.school_id = ${schoolId}
              AND viewer.active = true AND viewer.role IN ('school_admin', 'council_member')
          ))
          AND l.is_event = true AND l.status = 'active'
        ORDER BY r.created_at ASC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async listPendingEventReviews(schoolId) {
      if (!schoolId) throw new TypeError('invalid event review school');
      const statement = sql`SELECT r.event_id AS event_id, l.title AS event_title,
          r.user_id AS user_id, r.status AS status, r.created_at AS created_at,
          p.first_name AS first_name, p.last_name AS last_name, p.class_name AS class_name,
          p.person_type AS person_type, p.staff_position AS staff_position
        FROM fam_event_registrations AS r
        INNER JOIN fam_listings AS l ON l.id = r.event_id AND l.school_id = r.school_id
        INNER JOIN fam_user_profiles AS p ON p.user_id = r.user_id AND p.school_id = r.school_id
        WHERE r.school_id = ${schoolId} AND l.is_event = true AND l.status = 'active' AND r.status = 'pending'
        ORDER BY r.created_at ASC LIMIT 200;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0] ?? [];
    },

    async registerForEvent(eventId, userId, schoolId) {
      if (!eventId || !userId || !schoolId) throw new TypeError('invalid event registration');
      const outcome = await sql.begin({ idempotent: true }, async tx => {
        const listingResult = await tx`SELECT user_id, school_id, is_event, status, event_type, max_seats
          FROM fam_listings WHERE id = ${eventId} LIMIT 1;`;
        const event = listingResult?.[0]?.[0];
        if (!event || event.is_event !== true || event.status !== 'active'
            || !['open', 'request', 'limited'].includes(event.event_type)) {
          return { failure: 'event_unavailable' };
        }
        if (event.school_id !== schoolId) {
          return { failure: 'school_mismatch' };
        }
        if (event.user_id === userId) {
          return { failure: 'organizer_registration' };
        }

        const currentResult = await tx`SELECT status FROM fam_event_registrations
          WHERE event_id = ${eventId} AND user_id = ${userId} LIMIT 1;`;
        const current = currentResult?.[0]?.[0];
        if (current && ['pending', 'confirmed'].includes(current.status)) {
          return { failure: 'already_registered' };
        }

        const occupancyResult = await tx`SELECT taken FROM fam_event_occupancy WHERE event_id = ${eventId} LIMIT 1;`;
        const taken = Number(occupancyResult?.[0]?.[0]?.taken ?? 0);
        const limit = event.event_type === 'limited' ? Number(event.max_seats ?? 0) : 0;
        if (limit > 0 && taken >= limit) {
          return { failure: 'no_seats_available' };
        }

        const status = event.event_type === 'request' ? 'pending' : 'confirmed';
        if (!current || !['pending', 'confirmed'].includes(current.status)) {
          await tx`UPSERT INTO fam_event_occupancy (event_id, taken)
            VALUES (${eventId}, Unwrap(CAST(${taken + 1} AS Uint32)));`;
        }
        await tx`UPSERT INTO fam_event_registrations (event_id, user_id, school_id, status, created_at)
          VALUES (${eventId}, ${userId}, ${event.school_id}, ${status}, CurrentUtcTimestamp());`;
        return { registration: { event_id: eventId, user_id: userId, status } };
      });
      if (outcome?.failure) {
        const messages = {
          event_unavailable: 'event unavailable',
          school_mismatch: 'event unavailable',
          organizer_registration: 'organizer cannot register',
          already_registered: 'already registered',
          no_seats_available: 'no seats available',
        };
        const error = new Error(messages[outcome.failure] || 'event registration rejected');
        error.code = outcome.failure;
        throw error;
      }
      return outcome.registration;
    },

    async cancelEventRegistration(eventId, userId) {
      if (!eventId || !userId) throw new TypeError('invalid event registration');
      return sql.begin({ idempotent: true }, async tx => {
        const currentResult = await tx`SELECT status FROM fam_event_registrations
          WHERE event_id = ${eventId} AND user_id = ${userId} LIMIT 1;`;
        const current = currentResult?.[0]?.[0];
        if (!current || !['pending', 'confirmed'].includes(current.status)) return false;
        await tx`UPDATE fam_event_registrations SET status = 'cancelled'
          WHERE event_id = ${eventId} AND user_id = ${userId};`;
        const occupancyResult = await tx`SELECT taken FROM fam_event_occupancy WHERE event_id = ${eventId} LIMIT 1;`;
        const taken = Number(occupancyResult?.[0]?.[0]?.taken ?? 0);
        await tx`UPSERT INTO fam_event_occupancy (event_id, taken)
          VALUES (${eventId}, Unwrap(CAST(${Math.max(0, taken - 1)} AS Uint32)));`;
        return true;
      });
    },

    async listSchoolPulse(schoolId, userId) {
      if (!schoolId || !userId) throw new TypeError('invalid school pulse read');
      const announcementQuery = sql`SELECT announcement_id AS id, title, body, kind, published_at, event_starts_at
        FROM fam_school_announcements WHERE school_id = ${schoolId} AND published_at <= CurrentUtcTimestamp()
          AND expires_at > CurrentUtcTimestamp() ORDER BY published_at DESC LIMIT 6;`;
      const openEventQuery = sql`SELECT id, title, Unicode::Substring(description, 0, 450) AS body,
          created_at AS published_at, event_date, event_time
        FROM fam_listings WHERE school_id = ${schoolId} AND status = 'active' AND is_event = true
          AND max_seats = 0 AND (event_date = '' OR CAST(event_date AS Date) >= CurrentUtcDate())
        ORDER BY created_at DESC LIMIT 6;`;
      const pollQuery = sql`SELECT poll_id AS id, question, options_json, closes_at
        FROM fam_school_polls WHERE school_id = ${schoolId}
          AND closes_at > CurrentUtcTimestamp() - Interval('P7D') ORDER BY created_at DESC LIMIT 3;`;
      for (const statement of [announcementQuery, openEventQuery, pollQuery]) if (typeof statement?.on === 'function') statement.on('error', () => {});
      const [announcementResult, openEventResult, pollResult] = await Promise.all([announcementQuery, openEventQuery, pollQuery]);
      const announcements = (announcementResult?.[0] ?? []).map(row => ({
        id: row.id, title: row.title, body: row.body, kind: row.kind, published_at: row.published_at,
        event_starts_at: row.event_starts_at ?? null,
      }));
      const openEvents = (openEventResult?.[0] ?? []).map(row => ({
        id: row.id, title: row.title, body: row.body, kind: 'open_event',
        published_at: row.published_at, event_starts_at: null,
        event_date: row.event_date || null, event_time: row.event_time || null,
      }));
      const timestamp = value => value instanceof Date ? value.getTime() : Date.parse(value ?? '');
      const feed = [...openEvents, ...announcements].sort((left, right) => {
        const kindOrder = Number(right.kind === 'open_event') - Number(left.kind === 'open_event');
        if (kindOrder) return kindOrder;
        return (timestamp(right.published_at) || 0) - (timestamp(left.published_at) || 0);
      }).slice(0, 6);
      const polls = [];
      for (const poll of pollResult?.[0] ?? []) {
        let options;
        try { options = JSON.parse(poll.options_json); } catch { continue; }
        if (!Array.isArray(options) || options.length < 2 || options.length > 8) continue;
        const voteQuery = sql`SELECT choice_index, COUNT(*) AS votes FROM fam_school_poll_votes
          WHERE poll_id = ${poll.id} AND school_id = ${schoolId} GROUP BY choice_index;`;
        const myVoteQuery = sql`SELECT choice_index FROM fam_school_poll_votes
          WHERE poll_id = ${poll.id} AND voter_id = ${userId} AND school_id = ${schoolId} LIMIT 1;`;
        if (typeof voteQuery?.on === 'function') voteQuery.on('error', () => {});
        if (typeof myVoteQuery?.on === 'function') myVoteQuery.on('error', () => {});
        const [voteResult, myVoteResult] = await Promise.all([voteQuery, myVoteQuery]);
        const rows = voteResult?.[0] ?? [];
        const totalVotes = rows.reduce((sum, row) => sum + Number(row.votes ?? 0), 0);
        const counts = totalVotes >= 5 ? options.map((_, index) => {
          const row = rows.find(item => Number(item.choice_index) === index);
          return Number(row?.votes ?? 0);
        }) : null;
        const myVote = myVoteResult?.[0]?.[0]?.choice_index;
        polls.push({ ...poll, options, options_json: undefined, total_votes: totalVotes,
          my_vote: myVote === undefined ? null : Number(myVote), counts });
      }
      return { announcements: feed, polls };
    },

    async voteSchoolPoll({ pollId, schoolId, userId, choiceIndex }) {
      if (!pollId || !schoolId || !userId || !Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 7) {
        throw new TypeError('invalid school poll vote');
      }
      return sql.begin(async tx => {
        const profileRows = await tx`SELECT school_id, active FROM fam_user_profiles WHERE user_id = ${userId} LIMIT 1;`;
        const profile = profileRows?.[0]?.[0];
        if (!profile?.active || profile.school_id !== schoolId) return { ok: false, code: 'school_profile_required' };
        const pollRows = await tx`SELECT school_id, options_json, closes_at FROM fam_school_polls WHERE poll_id = ${pollId} LIMIT 1;`;
        const poll = pollRows?.[0]?.[0];
        if (!poll || poll.school_id !== schoolId) return { ok: false, code: 'poll_unavailable' };
        let options;
        try { options = JSON.parse(poll.options_json); } catch { return { ok: false, code: 'poll_unavailable' }; }
        if (!Array.isArray(options) || choiceIndex >= options.length) return { ok: false, code: 'invalid_choice' };
        if (new Date(poll.closes_at).getTime() <= Date.now()) return { ok: false, code: 'poll_closed' };
        const priorRows = await tx`SELECT choice_index FROM fam_school_poll_votes WHERE poll_id = ${pollId} AND voter_id = ${userId} LIMIT 1;`;
        if (priorRows?.[0]?.length) return { ok: false, code: 'already_voted' };
        await tx`INSERT INTO fam_school_poll_votes (poll_id, voter_id, school_id, choice_index, created_at)
          VALUES (${pollId}, ${userId}, ${schoolId}, Unwrap(CAST(${choiceIndex} AS Uint32)), CurrentUtcTimestamp());`;
        return { ok: true };
      });
    },

    async publishSchoolAnnouncement({ schoolId, authorId, title, body, kind, eventStartsAt }) {
      if (!schoolId || !authorId || !title || !body || !['news', 'important', 'open_event'].includes(kind)) throw new TypeError('invalid school announcement');
      const announcementId = randomUUID();
      return sql.begin(async tx => {
        const profileRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${authorId} LIMIT 1;`;
        const profile = profileRows?.[0]?.[0];
        if (!profile?.active || profile.school_id !== schoolId || !['school_admin', 'council_member'].includes(profile.role)) return { ok: false, code: 'trusted_school_role_required' };
        const countRows = await tx`SELECT COUNT(*) AS count FROM fam_school_announcements
          WHERE school_id = ${schoolId} AND published_at >= CurrentUtcTimestamp() - Interval('PT24H');`;
        if (Number(countRows?.[0]?.[0]?.count ?? 0) >= 4) return { ok: false, code: 'daily_announcement_limit' };
        if (kind === 'open_event') {
          await tx`INSERT INTO fam_school_announcements
            (announcement_id, school_id, author_id, title, body, kind, event_starts_at, published_at, expires_at)
            VALUES (${announcementId}, ${schoolId}, ${authorId}, ${title}, ${body}, ${kind}, Unwrap(CAST(${eventStartsAt} AS Timestamp)), CurrentUtcTimestamp(), Unwrap(CAST(${eventStartsAt} AS Timestamp) + Interval('PT12H')));`;
        } else {
          await tx`INSERT INTO fam_school_announcements
            (announcement_id, school_id, author_id, title, body, kind, event_starts_at, published_at, expires_at)
            VALUES (${announcementId}, ${schoolId}, ${authorId}, ${title}, ${body}, ${kind}, CAST(NULL AS Timestamp?), CurrentUtcTimestamp(), Unwrap(CurrentUtcTimestamp() + Interval('P14D')));`;
        }
        return { ok: true, id: announcementId };
      });
    },

    async publishSchoolPoll({ schoolId, authorId, question, options, closesAt }) {
      if (!schoolId || !authorId || !question || !Array.isArray(options) || !closesAt) throw new TypeError('invalid school poll');
      const pollId = randomUUID();
      const optionsJson = JSON.stringify(options);
      return sql.begin(async tx => {
        const profileRows = await tx`SELECT school_id, role, active FROM fam_user_profiles WHERE user_id = ${authorId} LIMIT 1;`;
        const profile = profileRows?.[0]?.[0];
        if (!profile?.active || profile.school_id !== schoolId || !['school_admin', 'council_member'].includes(profile.role)) return { ok: false, code: 'trusted_school_role_required' };
        const countRows = await tx`SELECT COUNT(*) AS count FROM fam_school_polls
          WHERE school_id = ${schoolId} AND created_at >= CurrentUtcTimestamp() - Interval('PT24H');`;
        if (Number(countRows?.[0]?.[0]?.count ?? 0) >= 2) return { ok: false, code: 'daily_poll_limit' };
        await tx`INSERT INTO fam_school_polls (poll_id, school_id, author_id, question, options_json, closes_at, created_at)
          VALUES (${pollId}, ${schoolId}, ${authorId}, ${question}, ${optionsJson}, Unwrap(CAST(${closesAt} AS Timestamp)), CurrentUtcTimestamp());`;
        return { ok: true, id: pollId };
      });
    },

    async moderateEventRegistration(eventId, userId, moderatorId, schoolId, decision) {
      if (!eventId || !userId || !moderatorId || !schoolId || !['confirmed', 'rejected'].includes(decision)) {
        throw new TypeError('invalid event review');
      }
      return sql.begin({ idempotent: true }, async tx => {
        const profileResult = await tx`SELECT school_id, role, active FROM fam_user_profiles
          WHERE user_id = ${moderatorId} LIMIT 1;`;
        const profile = profileResult?.[0]?.[0];
        if (!profile || profile.active !== true || profile.school_id !== schoolId) return false;
        const isSchoolReviewer = ['school_admin', 'council_member'].includes(profile.role);
        const eventResult = await tx`SELECT user_id, school_id, is_event FROM fam_listings
          WHERE id = ${eventId} LIMIT 1;`;
        const event = eventResult?.[0]?.[0];
        if (!event || event.is_event !== true || event.school_id !== schoolId
            || (event.user_id !== moderatorId && !isSchoolReviewer)) return false;
        const registrationResult = await tx`SELECT status FROM fam_event_registrations
          WHERE event_id = ${eventId} AND user_id = ${userId} LIMIT 1;`;
        const registration = registrationResult?.[0]?.[0];
        if (!registration || registration.status !== 'pending') return false;
        await tx`UPDATE fam_event_registrations SET status = ${decision}
          WHERE event_id = ${eventId} AND user_id = ${userId};`;
        if (decision === 'rejected') {
          const occupancyResult = await tx`SELECT taken FROM fam_event_occupancy WHERE event_id = ${eventId} LIMIT 1;`;
          const taken = Number(occupancyResult?.[0]?.[0]?.taken ?? 0);
          await tx`UPSERT INTO fam_event_occupancy (event_id, taken)
            VALUES (${eventId}, Unwrap(CAST(${Math.max(0, taken - 1)} AS Uint32)));`;
        }
        return true;
      });
    },

    async getSchoolAgentMetrics(schoolId) {
      if (!schoolId) throw new TypeError('invalid agent report school');
      const count = async statement => Number((await statement)?.[0]?.[0]?.count ?? 0);
      const [active, fresh, safety, highSafety, deletion, suspensions, ideas] = await Promise.all([
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE school_id = ${schoolId} AND status = 'active';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE school_id = ${schoolId} AND created_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_safety_incidents WHERE school_id = ${schoolId} AND reviewed_at IS NULL;`),
        count(sql`SELECT COUNT(*) AS count FROM fam_safety_incidents WHERE school_id = ${schoolId} AND reviewed_at IS NULL AND severity = 'high';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_deletion_requests WHERE school_id = ${schoolId} AND status IN ('pending', 'processing');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_suspensions WHERE school_id = ${schoolId} AND status = 'active' AND expires_at > CurrentUtcTimestamp();`),
        count(sql`SELECT COUNT(*) AS count FROM fam_ideas WHERE school_id = ${schoolId} AND admin_status = 'new';`),
      ]);
      return { listings: { active, new_24h: fresh }, safety: { unreviewed: safety, high_unreviewed: highSafety },
        account_requests: { deletion_pending: deletion, active_suspensions: suspensions }, ideas: { awaiting_council: ideas } };
    },

    async countPendingSchoolAgentIdeas(schoolId) {
      if (!schoolId) throw new TypeError('invalid agent report school');
      const rows = await sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE school_id = ${schoolId} AND status = 'pending';`;
      const count = Number(rows?.[0]?.[0]?.count ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid pending school proposals count');
      return count;
    },

    async saveSchoolAgentReport({ schoolId, date, summary, metrics }) {
      if (!schoolId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || typeof summary !== 'string' || !metrics) throw new TypeError('invalid school agent report');
      await sql`UPSERT INTO fam_agent_school_daily_reports (school_id, report_date, generated_at, summary, metrics_json)
        VALUES (${schoolId}, ${date}, CurrentUtcTimestamp(), ${summary}, ${JSON.stringify(metrics)});`;
    },

    async createSchoolAgentIdea({ id, schoolId, date, rule, count }) {
      if (!id || !schoolId || !date || !rule || !Number.isInteger(count) || count <= 0) throw new TypeError('invalid school agent idea');
      return sql.begin(async tx => {
        const prior = await tx`SELECT id FROM fam_agent_ideas WHERE school_id = ${schoolId} AND report_date = ${date} AND agent_rule_key = ${rule.key} LIMIT 1;`;
        if (prior?.[0]?.length) return false;
        await tx`INSERT INTO fam_agent_ideas
          (id, school_id, report_date, agent_rule_key, title, summary, benefit, complexity, risk, evidence_kind, evidence_summary, proposed_by, status, reviewed_by, reviewed_at, decision_note, created_at)
          VALUES (${id}, ${schoolId}, ${date}, ${rule.key}, ${rule.title}, ${rule.summary(count)}, ${rule.benefit}, ${rule.complexity || 'small'}, 'low', 'observed', ${rule.evidence(count)}, ${rule.proposedBy}, 'pending', NULL, NULL, NULL, CurrentUtcTimestamp());`;
        return true;
      });
    },

    async getGlobalAgentDailyMetrics() {
      const count = async statement => Number((await statement)?.[0]?.[0]?.count ?? 0);
      const [activeListings, newListings, unreviewedSafety, deletionRequests, activeSuspensions,
        pendingIdeas, approvedIdeas, rejectedIdeas] = await Promise.all([
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE status = 'active';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE created_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_safety_incidents WHERE reviewed_at IS NULL;`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_deletion_requests WHERE status IN ('pending', 'processing');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_account_suspensions WHERE status = 'active' AND expires_at > CurrentUtcTimestamp();`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'pending';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'approved';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'rejected';`),
      ]);
      return {
        listings: { active: activeListings, new_24h: newListings },
        safety: { unreviewed: unreviewedSafety },
        account_requests: { deletion_pending: deletionRequests, active_suspensions: activeSuspensions },
        ideas: { pending: pendingIdeas, approved: approvedIdeas, rejected: rejectedIdeas },
      };
    },

    async saveGlobalAgentDailyReport({ date, summary, metrics }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || typeof summary !== 'string' || !metrics) {
        throw new TypeError('invalid global agent report');
      }
      await sql`UPSERT INTO fam_agent_daily_reports (report_date, generated_at, summary, metrics_json)
        VALUES (${date}, CurrentUtcTimestamp(), ${summary}, ${JSON.stringify(metrics)});`;
    },

    async enqueueAgentDailyDigestTask(reportDate) {
      if (!isIsoDate(reportDate)) {
        throw new TypeError('invalid agent digest date');
      }
      return sql.begin(async tx => {
        const prior = await tx`SELECT status, attempt_count FROM fam_agent_daily_digest_tasks
          WHERE report_date = ${reportDate} LIMIT 1;`;
        if (prior?.[0]?.length) return { created: false, status: prior[0][0].status };
        await tx`INSERT INTO fam_agent_daily_digest_tasks
          (report_date, status, attempt_count, max_attempts, available_at, claimed_by, claim_token,
            lease_expires_at, generated_at, metrics_json, summary, last_error_code, created_at, updated_at)
          VALUES (${reportDate}, 'queued', Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(3 AS Uint32)),
            CurrentUtcTimestamp(), NULL, NULL, NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        return { created: true, status: 'queued' };
      });
    },

    async claimAgentDailyDigestTask(workerId, reportDate) {
      if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 80 || !isIsoDate(reportDate)) {
        throw new TypeError('invalid agent digest claim');
      }
      return sql.begin(async tx => {
        const candidates = await tx`SELECT report_date, status, attempt_count, max_attempts,
            CASE WHEN available_at <= CurrentUtcTimestamp() THEN true ELSE false END AS available,
            CASE WHEN lease_expires_at IS NULL OR lease_expires_at <= CurrentUtcTimestamp() THEN true ELSE false END AS lease_expired
          FROM fam_agent_daily_digest_tasks
          WHERE report_date = ${reportDate} AND attempt_count < max_attempts
            AND ((status IN ('queued', 'failed') AND available_at <= CurrentUtcTimestamp())
              OR (status = 'claimed' AND lease_expires_at <= CurrentUtcTimestamp()))
          ORDER BY report_date ASC LIMIT 1;`;
        const task = candidates?.[0]?.[0];
        if (!task) return null;
        const due = task.available === true && ['queued', 'failed'].includes(task.status)
          || task.status === 'claimed' && task.lease_expired === true;
        if (!due) return null;
        const claimToken = randomUUID();
        await tx`UPDATE fam_agent_daily_digest_tasks SET status = Unwrap(CAST('claimed' AS Utf8)),
            attempt_count = Unwrap(CAST(Unwrap(CAST(attempt_count AS Uint32)) + Unwrap(CAST(1 AS Uint32)) AS Uint32)),
            claimed_by = ${workerId}, claim_token = ${claimToken},
            lease_expires_at = CurrentUtcTimestamp() + Interval('PT2M'),
            last_error_code = CAST(NULL AS Utf8?), updated_at = CurrentUtcTimestamp()
          WHERE report_date = ${task.report_date};`;
        return { report_date: task.report_date, claim_token: claimToken };
      });
    },

    async getAgentDailyDigestMetrics() {
      const count = async statement => Number((await statement)?.[0]?.[0]?.count ?? 0);
      const [activeListings, newListings, pendingIdeas, queuedTasks, completedTasks, blockedTasks, failedTasks] = await Promise.all([
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE status = 'active';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_listings WHERE created_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_ideas WHERE status = 'pending';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_daily_digest_tasks WHERE status = 'queued';`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_daily_digest_tasks WHERE status = 'completed' AND generated_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_daily_digest_tasks WHERE status = 'blocked' AND updated_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
        count(sql`SELECT COUNT(*) AS count FROM fam_agent_daily_digest_tasks WHERE status = 'failed' AND updated_at >= CurrentUtcTimestamp() - Interval('PT24H');`),
      ]);
      return { active_listings: activeListings, new_listings_24h: newListings, pending_ideas: pendingIdeas,
        queued_tasks: queuedTasks, completed_tasks_24h: completedTasks, blocked_tasks_24h: blockedTasks, failed_tasks_24h: failedTasks };
    },

    async getRuBackgroundQueueHealth(now = Date.now) {
      if (typeof now !== 'function') throw new TypeError('invalid background queue clock');
      const count = async statement => {
        const value = Number((await statement)?.[0]?.[0]?.count ?? 0);
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid background queue count');
        return value;
      };
      const readQueue = async (statusesQuery, expiredQuery, failuresQuery, oldestQuery) => {
        const [statusRows, expiredLeases, recentFailures, oldestQueued] = await Promise.all([
          statusesQuery, count(expiredQuery), count(failuresQuery), oldestQuery,
        ]);
        const statuses = { queued: 0, claimed: 0, completed: 0, blocked: 0, failed: 0 };
        for (const row of statusRows?.[0] ?? []) {
          if (!Object.hasOwn(statuses, row.status)) throw new TypeError('invalid background queue status');
          const value = Number(row.count);
          if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid background queue status count');
          statuses[row.status] = value;
        }
        const oldest = oldestQueued?.[0]?.[0]?.oldest_queued_at;
        const oldestMs = oldest instanceof Date ? oldest.getTime() : typeof oldest === 'string' ? Date.parse(oldest) : NaN;
        const currentTime = Number(now());
        if (!Number.isFinite(currentTime)) throw new TypeError('invalid background queue health clock value');
        const oldestAgeMinutes = Number.isFinite(oldestMs) ? Math.max(0, Math.floor((currentTime - oldestMs) / 60_000)) : 0;
        return { statuses, expired_leases: expiredLeases, failed_or_blocked_24h: recentFailures,
          oldest_queued_age_minutes: oldestAgeMinutes };
      };
      const [dailyReports, siteErrorDigests] = await Promise.all([
        readQueue(sql`SELECT status, COUNT(*) AS count FROM fam_agent_daily_digest_tasks GROUP BY status;`,
          sql`SELECT COUNT(*) AS count FROM fam_agent_daily_digest_tasks WHERE status = 'claimed' AND lease_expires_at <= CurrentUtcTimestamp();`,
          sql`SELECT COUNT(*) AS count FROM fam_agent_daily_digest_tasks WHERE status IN ('failed', 'blocked') AND updated_at >= CurrentUtcTimestamp() - Interval('PT24H');`,
          sql`SELECT MIN(available_at) AS oldest_queued_at FROM fam_agent_daily_digest_tasks WHERE status = 'queued';`),
        readQueue(sql`SELECT status, COUNT(*) AS count FROM fam_site_error_digest_tasks GROUP BY status;`,
          sql`SELECT COUNT(*) AS count FROM fam_site_error_digest_tasks WHERE status = 'claimed' AND lease_expires_at <= CurrentUtcTimestamp();`,
          sql`SELECT COUNT(*) AS count FROM fam_site_error_digest_tasks WHERE status IN ('failed', 'blocked') AND updated_at >= CurrentUtcTimestamp() - Interval('PT24H');`,
          sql`SELECT MIN(available_at) AS oldest_queued_at FROM fam_site_error_digest_tasks WHERE status = 'queued';`),
      ]);
      return { checked_at: new Date(Number(now())).toISOString(), queues: { daily_reports: dailyReports,
        site_error_digests: siteErrorDigests }, content_read: false };
    },

    async completeAgentDailyDigestTask({ reportDate, claimToken, metrics, summary }) {
      const keys = ['active_listings', 'new_listings_24h', 'pending_ideas', 'queued_tasks', 'completed_tasks_24h', 'blocked_tasks_24h', 'failed_tasks_24h'];
      if (!isIsoDate(reportDate) || !UUID.test(claimToken || '')
          || !metrics || keys.some(key => !Number.isSafeInteger(metrics[key]) || metrics[key] < 0)
          || typeof summary !== 'string' || summary.length > 1000) throw new TypeError('invalid agent digest result');
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_daily_digest_tasks WHERE report_date = ${reportDate} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.status !== 'claimed' || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_daily_digest_tasks SET status = Unwrap(CAST('completed' AS Utf8)), generated_at = CurrentUtcTimestamp(),
            metrics_json = ${JSON.stringify(metrics)}, summary = ${summary}, claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
            lease_expires_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp()
          WHERE report_date = ${reportDate};`;
        return true;
      });
    },

    async retryAgentDailyDigestTask({ reportDate, claimToken, errorCode = 'digest_failed' }) {
      if (!isIsoDate(reportDate) || !UUID.test(claimToken || '')
          || !['digest_failed', 'database_unavailable', 'invalid_metrics'].includes(errorCode)) throw new TypeError('invalid agent digest retry');
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_daily_digest_tasks WHERE report_date = ${reportDate} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.status !== 'claimed' || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_daily_digest_tasks SET status = Unwrap(CAST('failed' AS Utf8)), available_at = CurrentUtcTimestamp() + Interval('PT5M'),
            last_error_code = ${errorCode}, claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
            lease_expires_at = CAST(NULL AS Timestamp?),
            updated_at = CurrentUtcTimestamp()
          WHERE report_date = ${reportDate};`;
        return true;
      });
    },

    async enqueueSiteErrorDigestTask(digestSlot) {
      if (!isQuarterHourSlot(digestSlot)) throw new TypeError('invalid site error digest slot');
      return sql.begin(async tx => {
        const prior = await tx`SELECT status, attempt_count FROM fam_site_error_digest_tasks
          WHERE digest_slot = ${digestSlot} LIMIT 1;`;
        if (prior?.[0]?.length) return { created: false, status: prior[0][0].status };
        await tx`INSERT INTO fam_site_error_digest_tasks
          (digest_slot, status, attempt_count, max_attempts, available_at, claimed_by, claim_token, lease_expires_at,
            generated_at, metrics_json, summary, last_error_code, created_at, updated_at)
          VALUES (${digestSlot}, 'queued', Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(3 AS Uint32)), CurrentUtcTimestamp(),
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
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
