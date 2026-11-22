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

    async startStepUpEmailChallenge({ issuer, subject, emailDigest, codeDigest, currentSeconds, expiresSeconds }) {
      if (!issuer || !subject || !/^[a-f0-9]{64}$/i.test(emailDigest || '')
          || !/^[a-f0-9]{64}$/i.test(codeDigest || '') || !Number.isSafeInteger(currentSeconds)
          || !Number.isSafeInteger(expiresSeconds) || expiresSeconds <= currentSeconds) throw new TypeError('invalid step-up email challenge');
      return sql.begin(async tx => {
        const rows = await tx`SELECT window_started_seconds, send_count, sent_seconds, expires_seconds, code_digest, confirmed_seconds
          FROM fam_step_up_email_challenges WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        const windowStart = Number(current?.window_started_seconds ?? 0);
        const sendCount = Number(current?.send_count ?? 0);
        const sentSeconds = Number(current?.sent_seconds ?? 0);
        const expiresSecondsCurrent = Number(current?.expires_seconds ?? 0);
        const sameWindow = windowStart > 0 && currentSeconds >= windowStart && currentSeconds - windowStart < 3600;
        // `confirmed_seconds` records that the one-time code was consumed; it
        // must remain set. A new challenge resets it only when the old code
        // expires, below.
        if (current?.code_digest && expiresSecondsCurrent > currentSeconds) {
          return { ok: false, code: 'verification_code_already_sent' };
        }
        if (sameWindow && sentSeconds > 0 && currentSeconds - sentSeconds < 60) {
          return { ok: false, code: 'email_send_cooldown', retry_after_seconds: 60 - (currentSeconds - sentSeconds) };
        }
        if (sameWindow && sendCount >= 3) return { ok: false, code: 'email_send_rate_limited' };
        const nextWindowStart = sameWindow ? windowStart : currentSeconds;
        const nextSendCount = sameWindow ? sendCount + 1 : 1;
        await tx`UPSERT INTO fam_step_up_email_challenges
          (issuer, subject, email_digest, code_digest, issued_seconds, expires_seconds, attempt_count,
           window_started_seconds, send_count, sent_seconds, confirmed_seconds)
          VALUES (${issuer}, ${subject}, ${emailDigest}, ${codeDigest}, ${new Uint64(BigInt(currentSeconds))},
            ${new Uint64(BigInt(expiresSeconds))}, ${new Uint32(0)}, ${new Uint64(BigInt(nextWindowStart))},
            ${new Uint32(nextSendCount)}, ${new Uint64(BigInt(currentSeconds))}, ${new Uint64(0n)});`;
        return { ok: true };
      });
    },

    async clearStepUpEmailChallenge({ issuer, subject, codeDigest }) {
      if (!issuer || !subject || !/^[a-f0-9]{64}$/i.test(codeDigest || '')) throw new TypeError('invalid step-up email cleanup');
      await sql`UPDATE fam_step_up_email_challenges SET code_digest = '', expires_seconds = 0, attempt_count = 0
        WHERE issuer = ${issuer} AND subject = ${subject} AND code_digest = ${codeDigest} AND confirmed_seconds = 0;`;
      return true;
    },

    async verifyStepUpEmailChallenge({ issuer, subject, emailDigest, codeDigest, currentSeconds }) {
      if (!issuer || !subject || !/^[a-f0-9]{64}$/i.test(emailDigest || '')
          || !/^[a-f0-9]{64}$/i.test(codeDigest || '') || !Number.isSafeInteger(currentSeconds)) throw new TypeError('invalid step-up email verification');
      return sql.begin(async tx => {
        const rows = await tx`SELECT email_digest, code_digest, expires_seconds, attempt_count, confirmed_seconds, issued_seconds
          FROM fam_step_up_email_challenges WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (!current || current.email_digest !== emailDigest || !current.code_digest) return { ok: false, code: 'invalid_verification_code' };
        if (Number(current.issued_seconds) > currentSeconds) return { ok: false, code: 'invalid_verification_code' };
        if (Number(current.confirmed_seconds) > 0) return { ok: false, code: 'verification_code_used' };
        if (Number(current.expires_seconds) <= currentSeconds) {
          await tx`UPDATE fam_step_up_email_challenges SET code_digest = '', attempt_count = 0
            WHERE issuer = ${issuer} AND subject = ${subject} AND email_digest = ${emailDigest}
              AND code_digest = ${current.code_digest} AND confirmed_seconds = 0;`;
          return { ok: false, code: 'verification_code_expired' };
        }
        const attempts = Number(current.attempt_count ?? 0);
        if (attempts >= 5) return { ok: false, code: 'verification_code_locked' };
        const expected = Buffer.from(String(current.code_digest), 'hex');
        const provided = Buffer.from(codeDigest, 'hex');
        if (expected.length !== 32 || !timingSafeEqual(expected, provided)) {
          const nextAttempts = attempts + 1;
          if (nextAttempts >= 5) {
            await tx`UPDATE fam_step_up_email_challenges SET attempt_count = ${new Uint32(nextAttempts)}, code_digest = ''
              WHERE issuer = ${issuer} AND subject = ${subject} AND email_digest = ${emailDigest}
                AND code_digest = ${current.code_digest} AND confirmed_seconds = 0;`;
          } else {
            await tx`UPDATE fam_step_up_email_challenges SET attempt_count = ${new Uint32(nextAttempts)}
              WHERE issuer = ${issuer} AND subject = ${subject} AND email_digest = ${emailDigest}
                AND code_digest = ${current.code_digest} AND confirmed_seconds = 0;`;
          }
          return { ok: false, code: nextAttempts >= 5 ? 'verification_code_locked' : 'invalid_verification_code' };
        }
        await tx`UPDATE fam_step_up_email_challenges SET code_digest = '', confirmed_seconds = ${new Uint64(BigInt(currentSeconds))}
          WHERE issuer = ${issuer} AND subject = ${subject} AND email_digest = ${emailDigest}
            AND code_digest = ${current.code_digest} AND issued_seconds = ${new Uint64(BigInt(Number(current.issued_seconds)))}
            AND expires_seconds > ${new Uint64(BigInt(currentSeconds))}
            AND confirmed_seconds = 0;`;
        const confirmed = await tx`SELECT confirmed_seconds FROM fam_step_up_email_challenges
          WHERE issuer = ${issuer} AND subject = ${subject} AND email_digest = ${emailDigest} LIMIT 1;`;
        const confirmedAt = Number(confirmed?.[0]?.[0]?.confirmed_seconds ?? 0);
        return confirmedAt === currentSeconds ? { ok: true, confirmed_at: confirmedAt, issued_seconds: Number(current.issued_seconds) }
          : { ok: false, code: 'invalid_verification_code' };
      });
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

    async claimExpiredPendingImages(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid pending media claim limit');
      return sql.begin(async tx => {
        const expired = await tx`SELECT object_key FROM fam_pending_media
          WHERE (status = 'pending' AND created_at < CurrentUtcTimestamp() - Interval('P7D'))
             OR (status = 'deleting' AND claim_until < CurrentUtcTimestamp())
          ORDER BY created_at ASC LIMIT ${limit};`;
        const claims = [];
        for (const row of expired?.[0] ?? []) {
          const objectKey = row.object_key;
          const stillLinked = await tx`SELECT id FROM fam_listings WHERE image_key = ${objectKey} LIMIT 1;`;
          if (stillLinked?.[0]?.length) {
            await tx`UPDATE fam_pending_media SET status = 'linked', claim_token = '' WHERE object_key = ${objectKey};`;
            continue;
          }
          const token = randomUUID();
          await tx`UPDATE fam_pending_media SET status = 'deleting', claim_token = ${token},
              claim_until = Unwrap(CurrentUtcTimestamp() + Interval('PT5M'))
            WHERE object_key = ${objectKey}
              AND ((status = 'pending' AND created_at < CurrentUtcTimestamp() - Interval('P7D'))
                OR (status = 'deleting' AND claim_until < CurrentUtcTimestamp()));`;
          const claimed = await tx`SELECT object_key, claim_token FROM fam_pending_media
            WHERE object_key = ${objectKey} AND status = 'deleting' AND claim_token = ${token} LIMIT 1;`;
          if (claimed?.[0]?.[0]) claims.push(claimed[0][0]);
        }
        return claims;
      });
    },

    async finishPendingImageCleanup(objectKey, claimToken, deleted) {
      if (!objectKey || !claimToken || typeof deleted !== 'boolean') throw new TypeError('invalid pending image cleanup result');
      return sql.begin(async tx => {
        const claimed = await tx`SELECT status FROM fam_pending_media WHERE object_key = ${objectKey}
          AND status = 'deleting' AND claim_token = ${claimToken} LIMIT 1;`;
        if (!claimed?.[0]?.length) return false;
        if (deleted) await tx`DELETE FROM fam_pending_media WHERE object_key = ${objectKey} AND status = 'deleting' AND claim_token = ${claimToken};`;
        else await tx`UPDATE fam_pending_media SET status = 'pending', claim_token = '', claim_until = CurrentUtcTimestamp()
          WHERE object_key = ${objectKey} AND status = 'deleting' AND claim_token = ${claimToken};`;
        return true;
      });
    },

    async moderateListing(listingId, schoolId, reviewerId, decision) {
      if (!listingId || !schoolId || !reviewerId || !['active', 'rejected'].includes(decision)) throw new TypeError('invalid listing decision');
      return sql.begin(async tx => {
        const reviewerRows = await tx`SELECT role, school_id, active FROM fam_user_profiles WHERE user_id = ${reviewerId} LIMIT 1;`;
        const reviewer = reviewerRows?.[0]?.[0];
        if (!reviewer || reviewer.active !== true || !['school_admin', 'council_member'].includes(reviewer.role) || reviewer.school_id !== schoolId) return false;
        const suspensionRows = await tx`SELECT suspension_id FROM fam_account_suspensions
          WHERE school_id = ${schoolId} AND target_id = ${reviewerId} AND status = 'active'
            AND expires_at > CurrentUtcTimestamp() LIMIT 1;`;
        if (suspensionRows?.[0]?.length) return false;
        const current = await tx`SELECT school_id, status, image_key, photo_status FROM fam_listings WHERE id = ${listingId};`;
        const row = current?.[0]?.[0];
        if (!row || row.school_id !== schoolId || row.status !== 'pending') return false;
        if (decision === 'active' && row.image_key && row.photo_status !== 'approved') return false;
        await tx`UPDATE fam_listings SET status = ${decision} WHERE id = ${listingId};`;
        return true;
      });
    },

    async getListingPhoto(listingId) {
      if (!listingId) throw new TypeError('invalid listing id');
      const statement = sql`SELECT user_id, school_id, status, image_key, photo_status
        FROM fam_listings WHERE id = ${listingId} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return (await statement)?.[0]?.[0] ?? null;
    },

    async listingUsesPhoto(imageKey) {
      if (!imageKey) throw new TypeError('invalid photo key');
      const statement = sql`SELECT id FROM fam_listings WHERE image_key = ${imageKey} LIMIT 1;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      return Boolean((await sta…49777 tokens truncated…{ status: 403, body: { ok: false, error: 'profile_unavailable' } };
      try { return { status: 200, body: { ok: true, messages: await repository.listMessages(actor.id, actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if ((req.method === 'GET' && pathname === '/api/v1/messages/moderation') || (req.method === 'PATCH' && pendingMessageReviewMatch)) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id || !actor.id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      const suspensionBlock = await schoolRoleSuspensionGate(actor);
      if (suspensionBlock) return suspensionBlock;
      if (req.method === 'GET') {
        if (typeof repository?.listPendingMessages !== 'function') return { status: 503, body: { ok: false, error: 'message_review_unavailable' } };
        try { return { status: 200, body: { ok: true, messages: await repository.listPendingMessages(actor.school_id) } }; }
        catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (!['approve', 'reject'].includes(input?.decision)) return { status: 400, body: { ok: false, error: 'invalid_decision' } };
      if (typeof repository?.decidePendingMessage !== 'function') return { status: 503, body: { ok: false, error: 'message_review_unavailable' } };
      try {
        const updated = await repository.decidePendingMessage({ messageId: pendingMessageReviewMatch[1], schoolId: actor.school_id, reviewerId: actor.id, decision: input.decision });
        return updated ? { status: 200, body: { ok: true } } : { status: 404, body: { ok: false, error: 'pending_message_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'POST' && listingContactMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (typeof repository?.getListingContactRecipient !== 'function') return { status: 503, body: { ok: false, error: 'contact_unavailable' } };
      try {
        const receiver_id = await repository.getListingContactRecipient(listingContactMatch[1], actor.id, actor.school_id);
        if (!receiver_id) return { status: 404, body: { ok: false, error: 'listing_unavailable' } };
        const result = await submitMessage({ actor, input: { body: input?.body, receiver_id, listing_id: listingContactMatch[1] }, repository, review, safetyKey });
        const status = result.ok ? 201 : result.code === 'database_unavailable' || result.status === 'pending' ? 503
          : result.code === 'recipient_unavailable' ? 404 : result.code === 'rate_limited' ? 429 : 400;
        return { status, body: result };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me/listings') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository?.listOwnActiveListingIds !== 'function') return { status: 503, body: { ok: false, error: 'own_listings_unavailable' } };
      try {
        const listing_ids = await repository.listOwnActiveListingIds(actor.id);
        const listings = typeof repository.listOwnListingSummaries === 'function'
          ? await repository.listOwnListingSummaries(actor.id) : [];
        return { status: 200, body: { ok: true, listing_ids, listings } };
      }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'DELETE' && schoolListingDeleteMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id || !actor.id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      const suspensionBlock = await schoolRoleSuspensionGate(actor);
      if (suspensionBlock) return suspensionBlock;
      if (typeof repository?.getSchoolListingDeletionContext !== 'function' || typeof repository?.deleteSchoolListing !== 'function') {
        return { status: 503, body: { ok: false, error: 'listing_delete_unavailable' } };
      }
      let context;
      try { context = await repository.getSchoolListingDeletionContext({ schoolId: actor.school_id, actorId: actor.id, listingId: schoolListingDeleteMatch[1] }); }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      if (!context) return { status: 404, body: { ok: false, error: 'listing_unavailable' } };
      if (context.user_id !== actor.id) {
        if (!hasFreshConfirmation(identity, now())) {
          return { status: 403, body: { ok: false, error: 'fresh_authentication_required' } };
        }
      }
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (input?.confirmation !== 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ') return { status: 400, body: { ok: false, error: 'confirmation_required' } };
      try {
        const deleted = await repository.deleteSchoolListing({ schoolId: actor.school_id, actorId: actor.id, listingId: schoolListingDeleteMatch[1] });
        if (!deleted?.ok) return { status: deleted?.code === 'forbidden' ? 403 : 404, body: { ok: false, error: deleted?.code || 'listing_unavailable' } };
        let imageCleanup = deleted.media_cleanup ? 'queued' : 'not_needed';
        if (deleted.media_cleanup && typeof pendingImages?.delete === 'function' && typeof repository.finishPendingImageCleanup === 'function') {
          try {
            await pendingImages.delete(deleted.media_cleanup.object_key);
            if (await repository.finishPendingImageCleanup(deleted.media_cleanup.object_key, deleted.media_cleanup.claim_token, true)) imageCleanup = 'complete';
          } catch { /* The five-minute lease lets the pending-media janitor retry. */ }
        }
        return { status: 200, body: { ok: true, deleted: true, image_cleanup: imageCleanup } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'DELETE' && ownListingMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || actor.role !== 'student') return { status: 403, body: { ok: false, error: 'student_profile_required' } };
      if (typeof repository?.deleteOwnListing !== 'function') return { status: 503, body: { ok: false, error: 'listing_delete_unavailable' } };
      try {
        const deleted = await repository.deleteOwnListing(actor.id, ownListingMatch[1]);
        if (!deleted) return { status: 404, body: { ok: false, error: 'listing_unavailable' } };
        let imageCleanup = deleted.media_cleanup ? 'queued' : 'not_needed';
        if (deleted.media_cleanup && typeof pendingImages?.delete === 'function'
            && typeof repository.finishPendingImageCleanup === 'function') {
          try {
            await pendingImages.delete(deleted.media_cleanup.object_key);
            if (await repository.finishPendingImageCleanup(deleted.media_cleanup.object_key, deleted.media_cleanup.claim_token, true)) imageCleanup = 'complete';
          } catch { /* The five-minute lease lets the pending-media janitor retry. */ }
        }
        return { status: 200, body: { ok: true, deleted: true, image_cleanup: imageCleanup } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'DELETE' && schoolIdeaDeleteMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.id || !actor.school_id) return { status: 403, body: { ok: false, error: 'school_profile_required' } };
      if (typeof repository?.getSchoolIdeaDeletionContext !== 'function' || typeof repository?.deleteSchoolIdea !== 'function') {
        return { status: 503, body: { ok: false, error: 'idea_delete_unavailable' } };
      }
      let context;
      try { context = await repository.getSchoolIdeaDeletionContext({ ideaId: schoolIdeaDeleteMatch[1], schoolId: actor.school_id }); }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      if (!context) return { status: 404, body: { ok: false, error: 'idea_unavailable' } };
      if (context.user_id !== actor.id) {
        if (actor.role !== 'school_admin') return { status: 403, body: { ok: false, error: 'forbidden' } };
        let input;
        try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
        if (input?.confirmation !== 'УДАЛИТЬ ИДЕЮ ШКОЛЫ') return { status: 400, body: { ok: false, error: 'confirmation_required' } };
      }
      let deleted;
      try { deleted = await repository.deleteSchoolIdea({ ideaId: schoolIdeaDeleteMatch[1], actorId: actor.id, schoolId: actor.school_id }); }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      if (!deleted?.ok) return { status: deleted?.code === 'forbidden' ? 403 : 404, body: { ok: false, error: deleted?.code || 'idea_unavailable' } };
      let imageCleanup = deleted.media_cleanup?.length ? 'queued' : 'not_needed';
      if (deleted.media_cleanup?.length && typeof pendingImages?.delete === 'function'
          && typeof repository.finishPendingImageCleanup === 'function') {
        let complete = true;
        for (const media of deleted.media_cleanup) {
          try {
            await pendingImages.delete(media.object_key);
            if (!await repository.finishPendingImageCleanup(media.object_key, media.claim_token, true)) complete = false;
          } catch { complete = false; }
        }
        imageCleanup = complete ? 'complete' : 'queued';
      }
      return { status: 200, body: { ok: true, deleted: true, image_cleanup: imageCleanup } };
    }
    const favoriteMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/favorite$/i);
    if (req.method === 'GET' && pathname === '/api/v1/favorites') {
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository.listFavoriteIds !== 'function') return { status: 503, body: { ok: false, error: 'favorite_read_unavailable' } };
      try { return { status: 200, body: { ok: true, favorite_ids: await repository.listFavoriteIds(actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (favoriteMatch && ['PUT', 'DELETE'].includes(req.method)) {
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository.setFavorite !== 'function') return { status: 503, body: { ok: false, error: 'favorite_write_unavailable' } };
      try {
        const favorited = await repository.setFavorite(actor.id, favoriteMatch[1], req.method === 'PUT');
        if (!favorited) return { status: 404, body: { ok: false, error: 'listing_not_found' } };
        return { status: 200, body: { ok: true, listing_id: favoriteMatch[1], favorited: req.method === 'PUT' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'PATCH' && pathname === '/api/v1/me') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let input;
      try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const first_name = typeof input?.first_name === 'string' ? input.first_name.trim() : '';
      const last_name = typeof input?.last_name === 'string' ? input.last_name.trim() : '';
      let currentProfile;
      if (input?.person_type == null || input?.staff_position == null || input?.class_name == null) {
        try { currentProfile = await resolveActor(identity); } catch { currentProfile = null; }
      }
      const person_type = input?.person_type ?? currentProfile?.person_type ?? 'student';
      const staff_position = typeof input?.staff_position === 'string' ? input.staff_position.trim() : (currentProfile?.staff_position ?? '');
      const class_name = typeof input?.class_name === 'string' ? input.class_name.trim().toUpperCase().replace(/\s+/gu, '')
        : (currentProfile?.class_name ?? '');
      const validName = value => value.length >= 1 && value.length <= 60 && !/[<>\u0000-\u001f]/u.test(value);
      if (!validName(first_name) || !validName(last_name) || !['student', 'school_staff', 'parent'].includes(person_type)
          || (person_type === 'student' && !isSchoolClassName(class_name))
          || (person_type !== 'student' && class_name !== '')
          || (person_type === 'school_staff' && (staff_position.length < 1 || staff_position.length > 100 || /[<>\u0000-\u001f]/u.test(staff_position)))
          || (person_type !== 'school_staff' && staff_position !== '')) {
        return { status: 400, body: { ok: false, error: 'invalid_profile_identity' } };
      }
      if (typeof repository?.updateOwnProfileIdentity !== 'function') return { status: 503, body: { ok: false, error: 'profile_update_unavailable' } };
      try {
        const profile = await repository.updateOwnProfileIdentity(identity.issuer, identity.subject,
          { first_name, last_name, class_name, person_type, staff_position });
        return profile ? { status: 200, body: { ok: true, profile } } : { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me') {
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      return { status: 200, body: { ok: true, profile: actor } };
    }
    if (req.method === 'GET' && pathname === '/api/v1/listings') {
      // Match the source FAM board policy: active listings are visible only
      // to signed-in profiles from the same school. Guests receive an empty
      // feed so the UI can show its login prompt without leaking school data.
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 200, body: { ok: true, listings: [] } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.school_id) return { status: 200, body: { ok: true, listings: [] } };
      if (typeof repository.listActiveListings !== 'function') {
        return { status: 503, body: { ok: false, error: 'listing_read_unavailable' } };
      }
      try {
        const listings = await repository.listActiveListings(actor.school_id);
        return { status: 200, body: { ok: true, listings } };
      } catch {
        return { status: 503, body: { ok: false, error: 'database_unavailable' } };
      }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me/ideas') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || typeof actor.id !== 'string' || !actor.school_id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository?.listOwnIdeas !== 'function') return { status: 503, body: { ok: false, error: 'ideas_unavailable' } };
      try {
        const ideas = await repository.listOwnIdeas(actor.id, actor.school_id);
        return { status: 200, body: { ok: true, ideas: Array.isArray(ideas) ? ideas.slice(0, 50) : [] } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    if (!['/api/v1/listings', '/api/v1/ideas', '/api/v1/messages'].includes(pathname)) return { status: 404, body: { ok: false, error: 'not_found' } };

    let identity;
    try { identity = await authenticate(req); } catch { identity = null; }
    if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    let actor;
    try { actor = await resolveActor(identity); } catch { actor = null; }
    if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
    let input;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } };
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
    const result = pathname === '/api/v1/ideas'
      ? await submitIdea({ actor, input, repository, review, safetyKey })
      : pathname === '/api/v1/messages'
        ? await submitMessage({ actor, input, repository, review, safetyKey })
        : await submitListing({ actor, input, repository, review, safetyKey });
    const status = result.ok ? 201
      : result.code === 'database_unavailable' || result.status === 'pending' ? 503
        : result.code === 'forbidden' ? 403
          : result.code === 'recipient_unavailable' ? 404 : result.code === 'rate_limited' ? 429 : 400;
    return { status, body: result };
  };
}
