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
      return Boolean((await sta…81328 tokens truncated…tedOwnDeletionRequests.body.requests[0].status, 'rejected');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/deletion-requests/review', 'synthetic-admin'))).body.requests.length, 0);
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/deletion-requests/review', 'synthetic-registrant'))).status, 403);
  assert.equal((await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-registrant', {
    target_id: '11111111-1111-4111-8111-111111111111', reason_code: 'spam', reason: 'Repeated unrelated posts in group.',
  }))).status, 403);
  console.log('YDB_ACCOUNT_DELETION_REQUEST_PASS: council submission/history, school-scoped admin queue/rejection, duplicate guard, and role enforcement');
  assert.equal((await listingsApi(apiRequest('POST', '/api/v1/profile-requests', 'synthetic-new-student', {
    school_id: 'lyceum_3', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б', role: 'school_admin',
  }))).status, 403, 'an unverified identity cannot create a school profile request');
  const sendProfileEmail = await listingsApi(apiRequest('POST', '/api/v1/profile-requests/email-verification', 'synthetic-new-student', { action: 'send' }),
    { token: { access_token: 'synthetic-yandex-function-iam-token-0123456789' } });
  assert.deepEqual(sendProfileEmail, { status: 202, body: { ok: true, sent: true, already_verified: false } });
  assert.deepEqual({ to: syntheticVerificationEmail.to, code: syntheticVerificationEmail.code },
    { to: 'new-student@synthetic.example', code: '135790' });
  const storedProfileChallenge = await sql`SELECT email_digest, code_digest FROM fam_role_email_verifications
    WHERE issuer = 'https://issuer.synthetic' AND subject = 'subject-new' LIMIT 1;`;
  assert.match(storedProfileChallenge[0][0].email_digest, /^[a-f0-9]{64}$/);
  assert.match(storedProfileChallenge[0][0].code_digest, /^[a-f0-9]{64}$/);
  assert.equal(storedProfileChallenge[0][0].email_digest.includes('new-student@synthetic.example'), false);
  assert.equal(storedProfileChallenge[0][0].code_digest.includes('135790'), false);
  assert.deepEqual(await listingsApi(apiRequest('POST', '/api/v1/profile-requests/email-verification', 'synthetic-new-student', { action: 'verify', code: '135790' })),
    { status: 200, body: { ok: true, email_verified: true } });
  console.log('YDB_PROFILE_EMAIL_VERIFICATION_PASS: unverified identity is blocked, synthetic code verifies, and YDB stores only HMAC digests');
  const profileSubmission = await listingsApi(apiRequest('POST', '/api/v1/profile-requests', 'synthetic-new-student', {
    school_id: 'lyceum_3', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б', role: 'school_admin',
  }));
  assert.equal(profileSubmission.status, 202);
  assert.equal(profileSubmission.body.status, 'pending');
  const privateProfileStatus = await listingsApi(apiRequest('GET', '/api/v1/profile-requests', 'synthetic-new-student'));
  assert.equal(privateProfileStatus.status, 200);
  assert.equal(privateProfileStatus.body.request.status, 'pending');
  assert.deepEqual(Object.keys(privateProfileStatus.body.request).sort(), ['created_at', 'request_id', 'school_id', 'status']);
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new' }), null,
    'an access request alone never creates a profile');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-student'))).status, 403,
    'students cannot read access requests');
  const profileQueue = await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-lyceum-admin'));
  assert.equal(profileQueue.status, 200);
  const profileRequest = profileQueue.body.requests.find(row => row.first_name === 'Тест' && row.last_name === 'Профиль');
  assert.ok(profileRequest);
  assert.equal(Object.hasOwn(profileRequest, 'subject'), false, 'review queue omits external identity subjects');  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${profileRequest.request_id}`, 'synthetic-admin', { decision: 'approve' }))).status, 404,
    'an administrator from another school cannot approve the request');
  const profileDecision = await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${profileRequest.request_id}`, 'synthetic-lyceum-admin', { decision: 'approve' }));
  assert.deepEqual(profileDecision, { status: 200, body: { ok: true, status: 'approved' } });
  const approvedActor = await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new' });
  assert.ok(approvedActor);
  assert.match(approvedActor.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ school_id: approvedActor.school_id, role: approvedActor.role, first_name: approvedActor.first_name,
    last_name: approvedActor.last_name, class_name: approvedActor.class_name }, {
    school_id: 'lyceum_3', role: 'student', first_name: 'Тест', last_name: 'Профиль', class_name: '7Б',
  });
  const unverifiedRoleSubmission = await listingsApi(apiRequest('POST', '/api/v1/role-requests', 'synthetic-role-student', { requested_role: 'Участник Ученического совета' }));
  assert.equal(unverifiedRoleSubmission.status, 403, 'school role request stays closed before the account email is verified');
  const sendRoleEmail = await listingsApi(apiRequest('POST', '/api/v1/role-requests/email-verification', 'synthetic-role-student', { action: 'send' }),
    { token: { access_token: 'synthetic-yandex-function-iam-token-0123456789' } });
  assert.deepEqual(sendRoleEmail, { status: 202, body: { ok: true, sent: true, already_verified: false } });
  assert.deepEqual({ to: syntheticVerificationEmail.to, code: syntheticVerificationEmail.code },
    { to: 'role-student@synthetic.example', code: '135790' });
  const storedChallenge = await sql`SELECT email_digest, code_digest, attempt_count FROM fam_role_email_verifications
    WHERE issuer = 'https://issuer.synthetic' AND subject = 'subject-role-student' LIMIT 1;`;
  assert.match(storedChallenge[0][0].email_digest, /^[a-f0-9]{64}$/);
  assert.match(storedChallenge[0][0].code_digest, /^[a-f0-9]{64}$/);
  assert.equal(storedChallenge[0][0].code_digest.includes('135790'), false);
  assert.equal(storedChallenge[0][0].email_digest.includes('role-student@synthetic.example'), false);
  const verifyRoleEmail = await listingsApi(apiRequest('POST', '/api/v1/role-requests/email-verification', 'synthetic-role-student', { action: 'verify', code: '135790' }));
  assert.deepEqual(verifyRoleEmail, { status: 200, body: { ok: true, email_verified: true } });
  const roleSubmission = await listingsApi(apiRequest('POST', '/api/v1/role-requests', 'synthetic-role-student', { requested_role: 'Участник Ученического совета' }));
  assert.equal(roleSubmission.status, 202, 'a verified student may request a fixed school role');
  const roleStatus = await listingsApi(apiRequest('GET', '/api/v1/role-requests', 'synthetic-role-student'));
  assert.equal(roleStatus.body.role, 'student');
  assert.equal(roleStatus.body.request.request_id, roleSubmission.body.request_id);
  await sql`UPDATE fam_user_profiles SET first_name = 'Тест', last_name = 'Заявитель', class_name = '8А'
    WHERE user_id = '55555555-5555-4555-8555-555555555555';`;
  const roleQueue = await listingsApi(apiRequest('GET', '/api/v1/role-requests/review', 'synthetic-admin'));
  assert.equal(roleQueue.status, 200);
  const roleRequest = roleQueue.body.requests.find(row => row.request_id === roleSubmission.body.request_id);
  assert.ok(roleRequest);
  assert.equal(roleRequest.requested_role, 'council_member');
  assert.deepEqual(roleRequest, { request_id: roleSubmission.body.request_id, account_code: '555555', applicant_name: 'Тест Заявитель',
    class_name: '8А', requested_role: 'council_member', status: 'pending', created_at: roleRequest.created_at,
    review_started_at: null, review_started_by_me: false });
  assert.equal(Object.hasOwn(roleRequest, 'user_id'), false, 'same-school reviewer gets a short account code instead of the full Yandex-linked ID');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/role-requests/${roleRequest.request_id}`, 'synthetic-lyceum-admin', { action: 'start_review' }))).status, 409,
    'a different school cannot claim the role request');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/role-requests/${roleRequest.request_id}`, 'synthetic-admin', { action: 'start_review' }))).status, 200);
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/role-requests/${roleRequest.request_id}`, 'synthetic-admin', { decision: 'approve' })),
    { status: 200, body: { ok: true, status: 'approved' } });
  const elevatedActor = await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-role-student' });
  assert.equal(elevatedActor.role, 'council_member', 'only the same-school administrator decision grants the role');
  const elevatedRoleStatus = await listingsApi(apiRequest('GET', '/api/v1/role-requests', 'synthetic-role-student'));  assert.equal(elevatedRoleStatus.body.role, 'council_member', 'the profile UI can refresh its database-backed role after approval');
  const profileEdit = await listingsApi(apiRequest('PATCH', '/api/v1/me', 'synthetic-role-student', {
    first_name: 'Советник', last_name: 'Тестовый', class_name: '9Б', role: 'school_admin', school_id: 'other-school', user_id: 'forged-user',
  }));
  assert.equal(profileEdit.status, 200);
  assert.deepEqual({ role: profileEdit.body.profile.role, school_id: profileEdit.body.profile.school_id,
    first_name: profileEdit.body.profile.first_name, last_name: profileEdit.body.profile.last_name, class_name: profileEdit.body.profile.class_name }, {
    role: 'council_member', school_id: 'synthetic-school', first_name: 'Советник', last_name: 'Тестовый', class_name: '9Б',
  });
  const auditRows = await sql`SELECT action, status FROM fam_school_role_request_audit WHERE request_id = ${roleRequest.request_id};`;
  assert.equal(auditRows?.[0]?.length, 3, 'submission, review claim, and decision are retained in the audit table');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/profile-requests', 'synthetic-new-student'))).body.request.status, 'approved');
  assert.equal((await listingsApi(apiRequest('POST', '/api/v1/profile-requests', 'synthetic-new-staff', {
    school_id: 'lyceum_3', first_name: 'Тест', last_name: 'Сотрудник', person_type: 'school_staff', staff_position: 'Учитель',
  }))).status, 403, 'an unverified school employee identity cannot create a profile request');
  const sendStaffEmail = await listingsApi(apiRequest('POST', '/api/v1/profile-requests/email-verification', 'synthetic-new-staff', { action: 'send' }),
    { token: { access_token: 'synthetic-yandex-function-iam-token-0123456789' } });
  assert.deepEqual(sendStaffEmail, { status: 202, body: { ok: true, sent: true, already_verified: false } });
  assert.deepEqual({ to: syntheticVerificationEmail.to, code: syntheticVerificationEmail.code },
    { to: 'new-staff@synthetic.example', code: '135790' });
  assert.deepEqual(await listingsApi(apiRequest('POST', '/api/v1/profile-requests/email-verification', 'synthetic-new-staff', { action: 'verify', code: '135790' })),
    { status: 200, body: { ok: true, email_verified: true } });
  const staffProfileSubmission = await listingsApi(apiRequest('POST', '/api/v1/profile-requests', 'synthetic-new-staff', {
    school_id: 'lyceum_3', first_name: 'Тест', last_name: 'Сотрудник', person_type: 'school_staff', staff_position: 'Учитель',
  }));
  assert.equal(staffProfileSubmission.status, 202);
  const staffRequest = (await listingsApi(apiRequest('GET', '/api/v1/profile-requests/review', 'synthetic-lyceum-admin')))
    .body.requests.find(row => row.first_name === 'Тест' && row.last_name === 'Сотрудник');
  assert.equal(staffRequest.person_type, 'school_staff');
  assert.equal(staffRequest.staff_position, 'Учитель');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/profile-requests/${staffRequest.request_id}`, 'synthetic-lyceum-admin', { decision: 'approve' }))).status, 200);
  const pendingStaff = await listingsApi(apiRequest('GET', '/api/v1/staff-verifications', 'synthetic-lyceum-admin'));
  assert.equal(pendingStaff.status, 200);
  const staffToVerify = pendingStaff.body.requests.find(row => row.first_name === 'Тест' && row.last_name === 'Сотрудник');
  assert.ok(staffToVerify);
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/staff-verifications/${staffToVerify.user_id}`, 'synthetic-lyceum-admin', { decision: 'approved' }))).status, 200);
  const verifiedStaff = await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-new-staff' });
  assert.equal(verifiedStaff.person_type, 'school_staff');
  assert.equal(verifiedStaff.staff_position, 'Учитель');
  assert.equal(verifiedStaff.staff_verification_status, 'approved');  const legacyStaffEdit = await listingsApi(apiRequest('PATCH', '/api/v1/me', 'synthetic-new-staff', {
    first_name: 'Тест', last_name: 'Сотрудник после правки',
  }));
  assert.equal(legacyStaffEdit.status, 200);
  assert.equal(legacyStaffEdit.body.profile.person_type, 'school_staff');
  assert.equal(legacyStaffEdit.body.profile.staff_position, 'Учитель');
  assert.equal(legacyStaffEdit.body.profile.staff_verification_status, 'approved',
    'an older profile form that omits category fields preserves verified staff status');
  const changedStaffPosition = await listingsApi(apiRequest('PATCH', '/api/v1/me', 'synthetic-new-staff', {
    first_name: 'Тест', last_name: 'Сотрудник', person_type: 'school_staff', staff_position: 'Директор', class_name: '',
  }));
  assert.equal(changedStaffPosition.status, 200);
  assert.equal(changedStaffPosition.body.profile.staff_verification_status, 'pending',
    'changing a verified staff position requires school administrator review again');
  const apiSubmission = await listingsApi(apiRequest('POST', '/api/v1/listings', 'synthetic-student', {
    title: 'Обмен учебниками', description: 'Синтетическое объявление для интеграционной проверки', category: 'Учёба',
  }));
  assert.equal(apiSubmission.status, 201);
  assert.equal(apiSubmission.body.status, 'pending');
  const pendingApiListings = await repo.listActiveListings('synthetic-school');
  assert.equal(pendingApiListings.some(row => row.id === apiSubmission.body.id), false,
    'API submissions remain invisible before school moderation');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/listings/${apiSubmission.body.id}/moderation`, 'synthetic-student', { decision: 'approve' }))).status, 403,
    'student cannot moderate even when using a valid database-backed identity');
  const apiApproval = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${apiSubmission.body.id}/moderation`, 'synthetic-admin', { decision: 'approve' }));
  assert.deepEqual(apiApproval, { status: 200, body: { ok: true, status: 'active' } });
  const approvedApiListings = await repo.listActiveListings('synthetic-school');
  assert.equal(approvedApiListings.some(row => row.id === apiSubmission.body.id), true,
    'approved API submission becomes visible through public projection');
  const title = "Синтетическая книга'); DELETE FROM fam_listings; --";
  const listing = await repo.createListing({ user_id: 'synthetic-user', school_id: 'synthetic-school', title,
    description: 'Учебник', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
    event_date: null, event_time: null, event_type: null, max_seats: 0, status: 'pending' });
  const sets = await sql`SELECT id, user_id, school_id, title, status FROM fam_listings WHERE id = ${listing.id};`;  assert.equal(sets[0].length, 1);
  assert.equal(sets[0][0].title, title);
  assert.equal(sets[0][0].user_id, 'synthetic-user');
  assert.equal(sets[0][0].school_id, 'synthetic-school');
  assert.equal(sets[0][0].status, 'pending');
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, true), false, 'pending listings cannot be favorited');
  const beforeDirectModeration = await repo.listActiveListings('synthetic-school');
  assert.equal(beforeDirectModeration.some(row => row.id === apiSubmission.body.id), true,
    'the separately API-approved item remains public');
  assert.equal(beforeDirectModeration.some(row => row.id === listing.id), false, 'pending content must not appear publicly');
  assert.equal(await repo.moderateListing(listing.id, 'other-school', '33333333-3333-4333-8333-333333333333', 'active'), false, 'other school cannot moderate');
  assert.equal(await repo.moderateListing(listing.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), true, 'school moderator can approve pending listing');
  const publicListings = await repo.listActiveListings('synthetic-school');
  assert.equal(publicListings.some(row => row.id === apiSubmission.body.id), true);
  const publicDirectListing = publicListings.find(row => row.id === listing.id);
  assert.ok(publicDirectListing);
  assert.deepEqual(await repo.listActiveListings('other-school'), [], 'the public feed never returns another school\'s listings');
  const notificationOwnerListing = await repo.createListing({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school',
    title: 'Синтетический материал для личной фильтрации уведомлений', description: 'Этот материал не должен попасть автору в новые объявления',
    category: 'Учёба', price_text: 'Бесплатно', is_event: false, event_date: null, event_time: null, event_type: null,
    max_seats: 0, status: 'pending' });
  assert.equal(await repo.moderateListing(notificationOwnerListing.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), true);
  const schoolNotificationFeed = await listingsApi(apiRequest('GET', '/api/v1/notifications/listings', 'synthetic-registrant'));
  assert.equal(schoolNotificationFeed.status, 200);
  assert.ok(schoolNotificationFeed.body.listings.some(row => row.id === apiSubmission.body.id),
    'a member receives notifications for another active listing from their school');
  assert.ok(schoolNotificationFeed.body.listings.some(row => row.id === listing.id));
  assert.ok(!schoolNotificationFeed.body.listings.some(row => row.id === notificationOwnerListing.id),
    'the author never receives a new-listing notification for their own material');
  assert.ok(schoolNotificationFeed.body.listings.every(row => !Object.hasOwn(row, 'school_id') && !Object.hasOwn(row, 'user_id')),
    'the notification projection omits school and author identifiers');
  const otherSchoolNotificationFeed = await listingsApi(apiRequest('GET', '/api/v1/notifications/listings', 'synthetic-other-school'));
  assert.deepEqual(otherSchoolNotificationFeed, { status: 200, body: { ok: true, listings: [] } },
    'notification query does not return another school\'s active content');
  assert.ok(await repo.deleteOwnListing('11111111-1111-4111-8111-111111111111', notificationOwnerListing.id),
    'remove the isolated notification fixture before unrelated own-listing assertions');
  assert.equal(await repo.getListingContactRecipient(listing.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school'), 'synthetic-user',
    'a same-school member can contact the owner of an active listing');
  assert.equal(await repo.getListingContactRecipient(listing.id, 'synthetic-user', 'synthetic-school'), null,
    'listing owners cannot open a self-conversation');
  assert.equal(await repo.getListingContactRecipient(listing.id, '11111111-1111-4111-8111-111111111111', 'other-school'), null,
    'listing contact lookup cannot cross school boundaries');
  assert.equal(publicDirectListing.title, title);
  assert.equal(Object.hasOwn(publicDirectListing, 'user_id'), false);
  assert.equal(Object.hasOwn(publicDirectListing, 'school_id'), false);
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, true), true);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), [listing.id]);
  assert.equal(await repo.setFavorite('synthetic-user', listing.id, false), true);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), []);

  const deletionPhotoKey = 'pending/11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp';  await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', deletionPhotoKey);
  const deletable = await repo.createListing({ user_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school',
    title: 'Своё синтетическое объявление', description: 'Проверка удаления владельцем', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: deletionPhotoKey, photo_status: 'approved', status: 'pending' });
  assert.equal(await repo.moderateListing(deletable.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), true);
  assert.equal(await repo.setFavorite('synthetic-user', deletable.id, true), true);
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/me/listings', 'synthetic-registrant'))).body.listing_ids, [deletable.id],
    'private own-listing projection only returns the authenticated student’s active ids');
  assert.equal((await listingsApi(apiRequest('DELETE', `/api/v1/listings/${deletable.id}`, 'synthetic-student', null))).status, 404,
    'a different student cannot remove someone else’s listing');
  assert.equal((await listingsApi(apiRequest('DELETE', `/api/v1/listings/${deletable.id}`, 'synthetic-admin', null))).status, 403,
    'school staff cannot use the ordinary-student self-delete route');
  const ownDelete = await listingsApi(apiRequest('DELETE', `/api/v1/listings/${deletable.id}`, 'synthetic-registrant', null));
  assert.deepEqual(ownDelete, { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.deepEqual(deletedMediaKeys, [deletionPhotoKey]);
  assert.equal((await repo.listActiveListings('synthetic-school')).some(row => row.id === deletable.id), false);
  assert.deepEqual(await repo.listFavoriteIds('synthetic-user'), []);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${deletionPhotoKey};`)?.[0]?.length ?? 0, 0,
    'deleted listing cleanup removes its media registry entry after the object store confirms deletion');
  const idea = await repo.createIdea({ user_id: 'synthetic-user', school_id: 'synthetic-school',
    text: 'Синтетическая идея книжного обмена', ai_status: 'pending', ai_summary: 'Синтетическая идея',
    ai_reason: 'review_unavailable', admin_status: 'new' });
  const ideaRows = await sql`SELECT user_id, school_id, text, ai_status, admin_status FROM fam_ideas WHERE id = ${idea.id};`;
  assert.equal(ideaRows[0][0].user_id, 'synthetic-user');
  assert.equal(ideaRows[0][0].school_id, 'synthetic-school');
  assert.equal(ideaRows[0][0].ai_status, 'pending');
  assert.equal(ideaRows[0][0].admin_status, 'new');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-council'))).body.ideas
    .some(item => item.id === idea.id), false, 'council cannot read AI-pending idea text from the review queue');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${idea.id}/moderation`, 'synthetic-council', { decision: 'reject' }))).status,
    403, 'council cannot decide an AI-pending idea through the HTTP route');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${idea.id}/moderation`, 'synthetic-admin', { decision: 'approve' })),
    { status: 200, body: { ok: true, ai_status: 'approved' } });
  const reviewedIdeaRows = await sql`SELECT ai_status FROM fam_ideas WHERE id = ${idea.id};`;  assert.equal(reviewedIdeaRows[0][0].ai_status, 'approved', 'school review publishes only an explicitly approved pending idea');
  assert.ok((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-council'))).body.ideas
    .some(item => item.id === idea.id), 'council can see the idea after administrator approval');
  assert.equal((await sql`SELECT action FROM fam_school_content_audit WHERE entity_id = ${idea.id};`)[0][0].action,
    'idea_text_approved', 'school text decisions are auditable without recording the idea text');
  const ideaWorkflow = await listingsApi(apiRequest('GET', '/api/v1/school/ideas/workflow', 'synthetic-admin'));
  assert.equal(ideaWorkflow.status, 200);
  assert.ok(ideaWorkflow.body.ideas.some(item => item.id === idea.id), 'approved school ideas appear in the scoped workflow list');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/workflow/${idea.id}/status`, 'synthetic-admin', { status: 'in_progress' })),
    { status: 200, body: { ok: true, admin_status: 'in_progress' } });
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/workflow/${idea.id}/status`, 'synthetic-admin', { status: 'done' })),
    { status: 200, body: { ok: true, admin_status: 'done' } });
  assert.equal((await sql`SELECT admin_status FROM fam_ideas WHERE id = ${idea.id};`)[0][0].admin_status, 'done');
  assert.deepEqual(new Set((await sql`SELECT action FROM fam_school_content_audit WHERE entity_id = ${idea.id};`)[0].map(row => row.action)),
    new Set(['idea_text_approved', 'idea_workflow_in_progress', 'idea_workflow_done']), 'status transitions are audited without storing idea text');
  const linkedListingId = '99999999-9999-4999-8999-999999999999';
  const message = await repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '11111111-1111-4111-8111-111111111111', school_id: 'synthetic-school', listing_id: linkedListingId, body: 'Синтетическое одобренное сообщение' });
  for (let index = 0; index < 7; index++) {
    await repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '11111111-1111-4111-8111-111111111111',
      school_id: 'synthetic-school', body: `Синтетическое сообщение ${index}` });
  }
  assert.deepEqual(await repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '11111111-1111-4111-8111-111111111111',
    school_id: 'synthetic-school', body: 'Девятое синтетическое сообщение' }), { ok: false, code: 'rate_limited' });
  const messageQuota = await sql`SELECT submission_count FROM fam_submission_quotas
    WHERE user_id = 'synthetic-user' AND action = 'message' ORDER BY window_start DESC LIMIT 1;`;
  assert.equal(messageQuota?.[0]?.[0]?.submission_count, 8, 'direct messages enforce the eight-per-minute bucket');
  const messageRows = await sql`SELECT sender_id, receiver_id, school_id, listing_id, body, is_read FROM fam_messages WHERE id = ${message.id};`;
  assert.equal(messageRows[0][0].receiver_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(messageRows[0][0].school_id, 'synthetic-school');
  assert.equal(messageRows[0][0].listing_id, linkedListingId);
  assert.equal(messageRows[0][0].is_read, false);
  const ownRateLimitedMessages = await repo.listMessages('synthetic-user', 'synthetic-school');
  assert.equal(ownRateLimitedMessages.length, 8, 'the sender inbox contains all eight allowed messages');
  assert.ok(ownRateLimitedMessages.some(row => row.id === message.id));
  assert.deepEqual(await repo.listMessages('unrelated-user', 'synthetic-school'), []);
  assert.equal(await repo.markMessageRead('synthetic-user', 'synthetic-school', message.id), false, 'sender cannot mark the recipient inbox as read');
  assert.equal(await repo.markMessageRead('11111111-1111-4111-8111-111111111111', 'synthetic-school', message.id), true);
  const readRows = await sql`SELECT is_read FROM fam_messages WHERE id = ${message.id};`;
  assert.equal(readRows[0][0].is_read, true);
  assert.deepEqual(await repo.createMessage({ sender_id: 'synthetic-user', receiver_id: '22222222-2222-4222-8222-222222222222', school_id: 'synthetic-school', body: 'cross-school synthetic' }),
    { ok: false, code: 'recipient_unavailable' });

  await sql`DELETE FROM fam_submission_quotas WHERE user_id = 'synthetic-user' AND action = 'message';`;
  const pendingMessageResponse = await listingsApi(apiRequest('POST', '/api/v1/messages', 'synthetic-user', {
    receiver_id: '11111111-1111-4111-8111-111111111111', body: 'Синтетическое сообщение ожидает школьной проверки',
  }));
  assert.equal(pendingMessageResponse.status, 201);
  assert.deepEqual({ ok: pendingMessageResponse.body.ok, status: pendingMessageResponse.body.status }, { ok: true, status: 'pending' });
  const pendingMessageQuota = await sql`SELECT submission_count FROM fam_submission_quotas
    WHERE user_id = 'synthetic-user' AND action = 'message' ORDER BY window_start DESC LIMIT 1;`;
  assert.equal(pendingMessageQuota?.[0]?.[0]?.submission_count, 1,
    'manual-review messages consume the same source-compatible message quota');
  const pendingMessageId = pendingMessageResponse.body.id;
  assert.equal((await repo.listMessages('11111111-1111-4111-8111-111111111111', 'synthetic-school')).some(row => row.id === pendingMessageId), false,
    'recipient inbox cannot see messages awaiting review');
  assert.equal((await repo.listPendingMessages('synthetic-school')).some(row => row.id === pendingMessageId), true);
  assert.equal((await repo.listPendingMessages('lyceum_3')).some(row => row.id === pendingMessageId), false,
    'pending messages are school-scoped');
  assert.equal(await repo.decidePendingMessage({ messageId: pendingMessageId, schoolId: 'synthetic-school', reviewerId: '44444444-4444-4444-8444-444444444444', decision: 'approve' }), false,    'an administrator from another school cannot approve the message');
  const messageReviewQueue = await listingsApi(apiRequest('GET', '/api/v1/messages/moderation', 'synthetic-admin', null));
  assert.equal(messageReviewQueue.status, 200);
  assert.equal(messageReviewQueue.body.messages.some(row => row.id === pendingMessageId), true);
  const messageReview = await listingsApi(apiRequest('PATCH', `/api/v1/messages/moderation/${pendingMessageId}`, 'synthetic-admin', { decision: 'approve' }));
  assert.equal(messageReview.status, 200);
  assert.equal((await repo.listPendingMessages('synthetic-school')).some(row => row.id === pendingMessageId), false);
  assert.equal((await repo.listMessages('11111111-1111-4111-8111-111111111111', 'synthetic-school')).some(row => row.id === pendingMessageId), true,
    'approved message is atomically delivered to the recipient inbox');

  const rejectedPending = await repo.createPendingMessage({ sender_id: 'synthetic-user', receiver_id: '11111111-1111-4111-8111-111111111111',
    school_id: 'synthetic-school', body: 'Синтетическое сообщение будет отклонено' });
  assert.equal(await repo.decidePendingMessage({ messageId: rejectedPending.id, schoolId: 'synthetic-school', reviewerId: '33333333-3333-4333-8333-333333333333', decision: 'reject' }), true);
  assert.equal((await repo.listMessages('11111111-1111-4111-8111-111111111111', 'synthetic-school')).some(row => row.id === rejectedPending.id), false,
    'rejected message is never delivered');

  const limitedEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическая встреча с ограниченным числом мест', description: 'Проверка атомарной записи', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-01', event_time: '12:00', event_type: 'limited', max_seats: 1, status: 'pending' });
  assert.equal(await repo.moderateListing(limitedEvent.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), true);
  const eventApiRequest = apiRequest('POST', `/api/v1/listings/${limitedEvent.id}/registrations`, 'synthetic-registrant', null);
  const registrationResponse = await listingsApi(eventApiRequest);
  assert.equal(registrationResponse.status, 201);
  assert.equal(registrationResponse.body.registration.status, 'confirmed');
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 1);
  const crossSchoolRegistration = await listingsApi(apiRequest('POST', `/api/v1/listings/${limitedEvent.id}/registrations`, 'synthetic-other-school', null));
  assert.deepEqual(crossSchoolRegistration, { status: 404, body: { ok: false, error: 'event_unavailable' } },
    'a student from another school cannot register for the event');
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 1, 'a rejected cross-school registration does not consume a seat');
  await assert.rejects(repo.registerForEvent(limitedEvent.id, '22222222-2222-4222-8222-222222222222', 'synthetic-school'), error => error.code === 'no_seats_available');
  assert.equal(await repo.cancelEventRegistration(limitedEvent.id, '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 0);
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/event-registrations', 'synthetic-registrant'))).body.registrations
    .filter(row => row.event_id === limitedEvent.id).map(row => row.status), ['cancelled']);
  const cancelledOccupancy = await listingsApi(apiRequest('GET', `/api/v1/listings/${limitedEvent.id}/occupancy`, 'synthetic-registrant'));
  assert.deepEqual(cancelledOccupancy, { status: 200, body: { ok: true, taken: 0 } },
    'same-school occupancy is available while its event is active');
  assert.deepEqual(await listingsApi(apiRequest('GET', `/api/v1/listings/${limitedEvent.id}/occupancy`, 'synthetic-other-school')),
    { status: 404, body: { ok: false, error: 'event_unavailable' } }, 'another school cannot inspect occupancy');
  const reRegistration = await repo.registerForEvent(limitedEvent.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school');
  assert.equal(reRegistration.status, 'confirmed', 'a cancelled registration can be created again');
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 1);
  const cancelRegisterRace = await Promise.allSettled([
    repo.cancelEventRegistration(limitedEvent.id, '11111111-1111-4111-8111-111111111111'),
    repo.registerForEvent(limitedEvent.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school'),
  ]);
  assert.ok(cancelRegisterRace.some(result => result.status === 'fulfilled'), 'at least one serialized race operation completes');
  const registrationAfterRace = await sql`SELECT status FROM fam_event_registrations
    WHERE event_id = ${limitedEvent.id} AND user_id = '11111111-1111-4111-8111-111111111111' LIMIT 1;`;
  if (registrationAfterRace?.[0]?.[0]?.status === 'cancelled') {
    await repo.registerForEvent(limitedEvent.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school');
  }
  assert.equal(await repo.getEventOccupancy(limitedEvent.id), 1,
    'cancellation and re-registration remain consistent under a concurrent race');
  await sql`UPDATE fam_listings SET status = 'rejected' WHERE id = ${limitedEvent.id};`;
  const hiddenOccupancy = await listingsApi(apiRequest('GET', `/api/v1/listings/${limitedEvent.id}/occupancy`, 'synthetic-registrant'));
  assert.deepEqual(hiddenOccupancy, { status: 404, body: { ok: false, error: 'event_unavailable' } },
    'occupancy is hidden after the event is no longer active');
  await sql`UPDATE fam_listings SET status = 'active' WHERE id = ${limitedEvent.id};`;
  const concurrentEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое мероприятие для гонки за местом', description: 'Параллельная проверка вместимости', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-03', event_time: '12:00', event_type: 'limited', max_seats: 1, status: 'pending' });
  assert.equal(await repo.moderateListing(concurrentEvent.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), true);
  const concurrentAttempts = await Promise.allSettled([
    repo.registerForEvent(concurrentEvent.id, '11111111-1111-4111-8111-111111111111', 'synthetic-school'),
    repo.registerForEvent(concurrentEvent.id, '22222222-2222-4222-8222-222222222222', 'synthetic-school'),
  ]);
  assert.equal(concurrentAttempts.filter(result => result.status === 'fulfilled').length, 1,
    'serializable capacity check permits at most one successful registration for the final seat');
  assert.equal(await repo.getEventOccupancy(concurrentEvent.id), 1, 'concurrent requests cannot overbook or lose the occupancy count');

  const reviewEvent = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое мероприятие по заявкам', description: 'Проверка школьного решения', category: 'Афиша',
    price_text: 'Бесплатно', is_event: true, event_date: '2099-05-02', event_time: '12:00', event_type: 'request', max_seats: 0, status: 'pending' });
  assert.equal(await repo.moderateListing(reviewEvent.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), true);
  const requestResponse = await listingsApi(apiRequest('POST', `/api/v1/listings/${reviewEvent.id}/registrations`, 'synthetic-registrant', null));
  assert.equal(requestResponse.status, 201);
  assert.equal(requestResponse.body.registration.status, 'pending');
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 1);
  const reviewQueue = await listingsApi(apiRequest('GET', '/api/v1/event-registrations/review', 'synthetic-admin'));
  assert.equal(reviewQueue.status, 200);
  assert.equal(reviewQueue.body.applications.some(row => row.event_id === reviewEvent.id && row.user_id === '11111111-1111-4111-8111-111111111111'), true,
    'same-school moderator can see the synthetic pending registration');
  assert.equal(reviewQueue.body.applications.some(row => row.user_id === '22222222-2222-4222-8222-222222222222'), false,
    'event review queue excludes registrations from other schools');
  const studentReviewQueue = await listingsApi(apiRequest('GET', '/api/v1/event-registrations/review', 'synthetic-student'));
  assert.equal(studentReviewQueue.status, 403, 'students cannot read the event review queue');
  assert.equal(await repo.moderateEventRegistration(reviewEvent.id, '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'other-school', 'confirmed'), false,    'event registration review is scoped to the event owner school');
  const reviewResponse = await listingsApi(apiRequest('PATCH', `/api/v1/listings/${reviewEvent.id}/registrations/11111111-1111-4111-8111-111111111111`, 'synthetic-admin', { decision: 'reject' }));
  assert.deepEqual(reviewResponse, { status: 200, body: { ok: true, status: 'rejected' } });
  assert.equal(await repo.getEventOccupancy(reviewEvent.id), 0, 'rejecting a pending request releases its reserved seat');
  await sql`UPSERT INTO fam_account_suspensions
    (school_id, target_id, suspension_id, target_role, duration_hours, reason, status, issued_by, created_at, expires_at)
    VALUES ('synthetic-school', 'synthetic-user', 'synthetic-suspension', 'student', 24,
      'Synthetic integration suspension', 'active', 'synthetic-admin', CurrentUtcTimestamp(),
      Unwrap(CurrentUtcTimestamp() + Interval('PT24H')));`;
  const suspendedWrite = await listingsApi(apiRequest('POST', '/api/v1/listings', 'synthetic-user', {
    title: 'Не должно сохраниться', description: 'Synthetic suspension guard', category: 'Учёба',
  }));
  assert.equal(suspendedWrite.status, 403, 'active account suspension blocks authenticated writes');
  assert.equal(suspendedWrite.body.error, 'account_suspended');
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/listings', 'synthetic-user'))).status, 200,
    'account suspension leaves read access available');
  assert.equal((await repo.getActiveAccountSuspension('synthetic-school', 'synthetic-user'))?.reason,
    'Synthetic integration suspension');
  const photoKey = 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  await repo.registerPendingImage('33333333-3333-4333-8333-333333333333', photoKey);
  const photoListing = await repo.createListing({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    title: 'Синтетическое объявление с фото', description: 'Изображение остаётся закрытым до отдельного одобрения', category: 'Творчество',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: photoKey,
    photo_status: 'pending', status: 'pending' });
  assert.equal(await repo.claimPendingImageDeletion('33333333-3333-4333-8333-333333333333', photoKey), null,
    'an uploaded image cannot be discarded after it is atomically linked to a listing');
  assert.equal(await repo.moderateListing(photoListing.id, 'synthetic-school', '33333333-3333-4333-8333-333333333333', 'active'), false,
    'listing with pending photo cannot become public');
  assert.equal((await repo.listActiveListings('synthetic-school')).some(row => row.id === photoListing.id), false,
    'pending photo listing remains absent from the public projection');  const avatarKey = 'pending/11111111-1111-4111-8111-111111111111/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.webp';
  await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', avatarKey);
  const avatarSubmit = await listingsApi(apiRequest('POST', '/api/v1/me/avatar', 'synthetic-registrant', { image_key: avatarKey }));
  assert.equal(avatarSubmit.status, 202, 'avatar uploads stay private and enter manual school review');
  const avatarQueue = await listingsApi(apiRequest('GET', '/api/v1/avatars/moderation', 'synthetic-admin', null));
  assert.equal(avatarQueue.status, 200);
  assert.ok(avatarQueue.body.requests.some(item => item.id === avatarSubmit.body.request_id));
  assert.equal((await repo.listPendingAvatarReviews('other-school')).some(item => item.id === avatarSubmit.body.request_id), false,
    'other schools cannot discover pending avatars');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/avatars/${avatarSubmit.body.request_id}/moderation`, 'synthetic-registrant', { decision: 'approve' }))).status, 403,
    'students cannot approve an avatar');
  assert.equal((await listingsApi(apiRequest('PATCH', `/api/v1/avatars/${avatarSubmit.body.request_id}/moderation`, 'synthetic-admin', { decision: 'approve' }))).status, 200);
  assert.equal(await repo.isCurrentAvatar(avatarSubmit.body.request_id), true,
    'approved avatar URL is associated with the reviewed profile');
  const orphanKey = 'pending/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp';
  await repo.registerPendingImage('11111111-1111-4111-8111-111111111111', orphanKey);
  await sql`UPDATE fam_pending_media SET created_at = Unwrap(CurrentUtcTimestamp() - Interval('P8D')) WHERE object_key = ${orphanKey};`;
  const expiredMediaClaims = await repo.claimExpiredPendingImages(10);
  assert.deepEqual(expiredMediaClaims.map(item => item.object_key), [orphanKey],
    'stale unlinked uploads are claimed while the image attached to a listing is preserved');
  assert.equal(await repo.finishPendingImageCleanup(orphanKey, expiredMediaClaims[0].claim_token, true), true);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${orphanKey};`)?.[0]?.length ?? 0, 0,
    'completed cleanup removes the private media registry row');
  const otherSchoolPending = await repo.createListing({ user_id: '22222222-2222-4222-8222-222222222222', school_id: 'other-school',
    title: 'Чужое школьное объявление', description: 'Не должно попасть в очередь', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, status: 'pending' });
  const moderationQueue = await listingsApi(apiRequest('GET', '/api/v1/listings/moderation', 'synthetic-admin'));
  assert.equal(moderationQueue.status, 200);
  assert.ok(moderationQueue.body.listings.some(row => row.id === photoListing.id), 'school queue includes its own pending photo listing');
  assert.ok(!moderationQueue.body.listings.some(row => row.id === otherSchoolPending.id), 'school queue excludes other-school listings');  assert.equal(moderationQueue.body.listings.find(row => row.id === photoListing.id).photo_url, `/api/v1/listings/${photoListing.id}/photo`);
  const schoolDeleteMedia = 'pending/55555555-5555-4555-8555-555555555555/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp';
  await repo.registerPendingImage('55555555-5555-4555-8555-555555555555', schoolDeleteMedia);
  const schoolDeleteListing = await repo.createListing({ user_id: '55555555-5555-4555-8555-555555555555', school_id: 'synthetic-school',
    title: 'Синтетическое объявление для удаления администратором', description: 'Тестируется только на одноразовой базе', category: 'Книги',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: schoolDeleteMedia, photo_status: 'pending', status: 'pending' });
  accountMediaKeys.add(schoolDeleteMedia);
  assert.equal((await listingsApi(apiRequest('DELETE', `/api/v1/school/listings/${otherSchoolPending.id}`, 'synthetic-admin', {
    confirmation: 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ',
  }))).status, 404, 'administrator cannot delete another school listing');
  const schoolDeleteResult = await listingsApi(apiRequest('DELETE', `/api/v1/school/listings/${schoolDeleteListing.id}`, 'synthetic-admin', {
    confirmation: 'УДАЛИТЬ ОБЪЯВЛЕНИЕ ШКОЛЫ',
  }));
  assert.deepEqual(schoolDeleteResult, { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } });
  assert.ok(deletedMediaKeys.includes(schoolDeleteMedia), 'school listing deletion removes its registered private image');
  assert.equal((await sql`SELECT id FROM fam_listings WHERE id = ${schoolDeleteListing.id};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${schoolDeleteMedia};`)?.[0]?.length ?? 0, 0);
  const schoolDeleteAudit = await sql`SELECT school_id, actor_id, entity_id, entity_type, action FROM fam_school_content_audit WHERE entity_id = ${schoolDeleteListing.id};`;
  assert.deepEqual(schoolDeleteAudit?.[0]?.[0], { school_id: 'synthetic-school', actor_id: '33333333-3333-4333-8333-333333333333',
    entity_id: schoolDeleteListing.id, entity_type: 'listing', action: 'listing_deleted' });
  const adminOverview = await listingsApi(apiRequest('GET', '/api/v1/school/admin/overview', 'synthetic-admin'));
  assert.equal(adminOverview.status, 200);
  assert.ok(adminOverview.body.users.some(row => row.id === '33333333-3333-4333-8333-333333333333'));
  assert.ok(!adminOverview.body.users.some(row => row.id === '22222222-2222-4222-8222-222222222222'), 'school overview excludes profiles from other schools');
  assert.ok(adminOverview.body.listings.some(row => row.id === otherSchoolPending.id) === false, 'school overview excludes listings from another school');
  assert.ok(adminOverview.body.audit.some(row => row.action === 'listing_deleted'), 'school overview returns the recent school action audit');
  const safetyFingerprint = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  for (let i = 0; i < 3; i++) {
    await sql`INSERT INTO fam_safety_incidents (school_id, pair_fingerprint, source_kind, category, incident_id, severity,
      created_at, reviewed_at, reviewed_by, actor_id, target_id, source_origin, evidence_excerpt)      VALUES ('synthetic-school', ${safetyFingerprint}, 'message', 'targeted_harassment', ${`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`},
        ${i === 0 ? 'medium' : 'high'}, CurrentUtcTimestamp(), NULL, NULL, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111', 'fam.example.ru', 'synthetic sanitized excerpt');`;
  }
  const safetyReports = await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-admin'));
  assert.equal(safetyReports.status, 200);
  const safetyGroup = safetyReports.body.reports.find(row => row.fingerprint === safetyFingerprint);
  assert.equal(safetyGroup.occurrences, 3);
  assert.equal(safetyGroup.severity, 'high');
  assert.equal(safetyGroup.actor.first_name, 'Тест');
  const emittedSafety = await listingsApi(apiRequest('POST', '/api/v1/messages', 'synthetic-safety-actor', {
    receiver_id: '11111111-1111-4111-8111-111111111111', body: 'Поступали угрозы в адрес ученика.',
  }));
  assert.equal(emittedSafety.status, 201);
  assert.equal(emittedSafety.body.status, 'pending');
  for (const body of ['Давайте все будем высмеивать одного ученика в чате.',
    'Напишите ему все неприятные сообщения, чтобы он ушёл из чата.']) {
    const reviewed = await listingsApi(apiRequest('POST', '/api/v1/messages', 'synthetic-safety-actor', {
      receiver_id: '55555555-5555-4555-8555-555555555555', body,
    }));
    assert.equal(reviewed.status, 201);
    assert.equal(reviewed.body.status, 'pending', 'new local safety markers remain pending for human review');
  }
  assert.equal((await sql`SELECT id FROM fam_messages WHERE sender_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';`)?.[0]?.length ?? 0, 0,
    'unreviewed message stays out of the recipient inbox');
  assert.equal((await sql`SELECT id FROM fam_pending_messages WHERE sender_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';`)?.[0]?.length ?? 0, 3,
    'unreviewed message is kept in the school review queue');
  const localIncidents = await sql`SELECT category, severity, evidence_excerpt FROM fam_safety_incidents
    WHERE actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND target_id = '55555555-5555-4555-8555-555555555555' AND source_kind = 'message'
      AND category IN ('targeted_harassment', 'negative_personal_call');`;
  const localIncidentByCategory = new Map((localIncidents?.[0] ?? []).map(row => [row.category, row]));
  assert.deepEqual([...localIncidentByCategory.keys()].sort(), ['negative_personal_call', 'targeted_harassment']);
  for (const row of localIncidentByCategory.values()) {
    assert.equal(row.severity, 'medium');
    assert.equal(row.evidence_excerpt, null, 'local classifier never persists the source text');
  }
  const emittedIncident = await sql`SELECT pair_fingerprint, category, severity, evidence_excerpt FROM fam_safety_incidents
    WHERE actor_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND source_kind = 'message'
      AND category = 'threat_or_intimidation' ORDER BY created_at DESC LIMIT 1;`;
  assert.match(emittedIncident?.[0]?.[0]?.pair_fingerprint || '', /^[0-9a-f]{64}$/);
  assert.equal(emittedIncident?.[0]?.[0]?.category, 'threat_or_intimidation');
  assert.equal(emittedIncident?.[0]?.[0]?.severity, 'high');
  assert.equal(emittedIncident?.[0]?.[0]?.evidence_excerpt, null);
  const emittedQueue = await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-admin'));
  assert.ok(emittedQueue.body.reports.some(row => row.category === 'threat_or_intimidation'));
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-lyceum-admin'))).body.reports.length, 0,
    'safety reports are isolated by school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', '/api/v1/school/admin/safety-reports', 'synthetic-admin', {    fingerprint: safetyFingerprint, category: 'targeted_harassment', source_kind: 'message',
  })), { status: 200, body: { ok: true } });
  assert.equal((await listingsApi(apiRequest('GET', '/api/v1/school/admin/safety-reports', 'synthetic-admin'))).body.reports.some(row => row.fingerprint === safetyFingerprint), false,
    'acknowledged safety clusters leave the unreviewed queue');
  const adminIdeaImageKey = 'pending/33333333-3333-4333-8333-333333333333/aaaaaaaa-0000-4000-8000-000000000001.webp';
  accountMediaKeys.add(adminIdeaImageKey);
  await repo.registerPendingImage('33333333-3333-4333-8333-333333333333', adminIdeaImageKey);
  const adminOwnIdea = await repo.createIdea({ user_id: '33333333-3333-4333-8333-333333333333', school_id: 'synthetic-school',
    text: 'Идея администратора для самопроверки', image_keys: [adminIdeaImageKey], image_status: 'pending',
    ai_status: 'approved', admin_status: 'new' });
  assert.equal((await repo.listPendingSchoolIdeas('synthetic-school', '33333333-3333-4333-8333-333333333333', 'school_admin'))
    .some(idea => idea.id === adminOwnIdea.id), false, 'review queue omits the reviewer own submission');
  assert.equal(await repo.reviewSchoolIdeaImages({ ideaId: adminOwnIdea.id, schoolId: 'synthetic-school',
    reviewerId: '33333333-3333-4333-8333-333333333333', decision: 'approve' }), false,
  'school staff cannot approve their own idea photo');
  const deletedAdminIdea = await listingsApi(apiRequest('DELETE', `/api/v1/ideas/${adminOwnIdea.id}`, 'synthetic-admin', null));
  assert.deepEqual(deletedAdminIdea, { status: 200, body: { ok: true, deleted: true, image_cleanup: 'complete' } },
    'an idea author can delete their own idea and immediately clean linked private photos');
  assert.ok(deletedMediaKeys.includes(adminIdeaImageKey));
  assert.equal((await sql`SELECT id FROM fam_ideas WHERE id = ${adminOwnIdea.id};`)[0].length, 0);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${adminIdeaImageKey};`)[0].length, 0);
  const deletingUserId = '11111111-1111-4111-8111-111111111111';
  const deletingImageKey = `pending/${deletingUserId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`;
  const attachedIdeaImageKey = `pending/${deletingUserId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp`;
  const rejectedIdeaImageKey = `pending/${deletingUserId}/ffffffff-ffff-4fff-8fff-ffffffffffff.webp`;
  accountMediaKeys.add(deletingImageKey);
  await repo.registerPendingImage(deletingUserId, deletingImageKey);
  accountMediaKeys.add(attachedIdeaImageKey);
  await repo.registerPendingImage(deletingUserId, attachedIdeaImageKey);
  const ideaSubmission = await listingsApi(apiRequest('POST', '/api/v1/ideas', 'synthetic-registrant', {
    text: 'Добавить синтетическую книжную полку в школьную библиотеку', image_keys: [attachedIdeaImageKey],
  }));
  assert.equal(ideaSubmission.status, 201);
  assert.equal(ideaSubmission.body.image_status, 'pending');
  const ideaQueue = await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-admin'));
  const submittedIdea = ideaQueue.body.ideas.find(idea => idea.id === ideaSubmission.body.id);
  assert.equal(submittedIdea.image_status, 'pending');  assert.deepEqual(submittedIdea.image_keys, [attachedIdeaImageKey]);
  assert.equal(Object.hasOwn(submittedIdea, 'user_id'), false, 'school review queue omits the submitter identity');
  assert.equal(submittedIdea.ai_status, 'approved', 'unflagged text follows the free local fallback review path');
  assert.ok((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-council'))).body.ideas
    .some(item => item.id === ideaSubmission.body.id), 'council can review photos after the text passes the local safety gate');
  assert.deepEqual((await listingsApi(apiRequest('GET', '/api/v1/school/ideas', 'synthetic-lyceum-admin'))).body.ideas, [],
    'school idea queue is isolated by school');
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${ideaSubmission.body.id}/images`, 'synthetic-council', { decision: 'approve' })),
    { status: 200, body: { ok: true, image_status: 'approved' } });
  assert.equal((await repo.getSchoolIdeaImage(ideaSubmission.body.id, 0)).image_status, 'approved');
  accountMediaKeys.add(rejectedIdeaImageKey);
  await repo.registerPendingImage(deletingUserId, rejectedIdeaImageKey);
  const rejectedIdea = await listingsApi(apiRequest('POST', '/api/v1/ideas', 'synthetic-registrant', {
    text: 'Проверка безопасного отклонения фото', image_keys: [rejectedIdeaImageKey],
  }));
  assert.equal(rejectedIdea.status, 201);
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${rejectedIdea.body.id}/images`, 'synthetic-admin', { decision: 'reject' })),
    { status: 200, body: { ok: true, image_status: 'rejected' } });
  const rejectedIdeaRow = await sql`SELECT image_status FROM fam_ideas WHERE id = ${rejectedIdea.body.id};`;
  assert.deepEqual(rejectedIdeaRow[0][0], { image_status: 'rejected' });
  assert.deepEqual(await repo.listPendingSchoolIdeas('synthetic-school', '66666666-6666-4666-8666-666666666666', 'council_member')
    .then(rows => rows.find(row => row.id === rejectedIdea.body.id)?.image_keys), []);
  assert.equal(await repo.getSchoolIdeaImage(rejectedIdea.body.id, 0), null,
    'rejected school idea image is no longer readable');
  assert.equal((await sql`SELECT status FROM fam_pending_media WHERE object_key = ${rejectedIdeaImageKey};`)[0][0].status, 'pending',
    'rejected school idea image returns to the bounded orphan cleanup queue');
  const rejectedTextImageKey = `pending/${deletingUserId}/12345678-1234-4234-8234-123456789012.webp`;
  await repo.registerPendingImage(deletingUserId, rejectedTextImageKey);
  const rejectedTextIdea = await repo.createIdea({ user_id: deletingUserId, school_id: 'synthetic-school',
    text: 'Идея отклоняется модератором школы', image_keys: [rejectedTextImageKey], image_status: 'pending',
    ai_status: 'pending', admin_status: 'new' });
  assert.deepEqual(await listingsApi(apiRequest('PATCH', `/api/v1/school/ideas/${rejectedTextIdea.id}/moderation`, 'synthetic-admin', { decision: 'reject' })),
    { status: 200, body: { ok: true, ai_status: 'rejected' } });  assert.equal((await repo.listPendingSchoolIdeas('synthetic-school', '66666666-6666-4666-8666-666666666666', 'council_member'))
    .some(row => row.id === rejectedTextIdea.id), false, 'rejected idea text leaves the school review queue');
  assert.equal(await repo.getSchoolIdeaImage(rejectedTextIdea.id, 0), null, 'text rejection prevents reading its attached photo');
  assert.equal((await sql`SELECT status FROM fam_pending_media WHERE object_key = ${rejectedTextImageKey};`)[0][0].status, 'pending',
    'text rejection safely releases its photo to the bounded orphan cleanup queue');
  const deletingListing = await repo.createListing({ user_id: deletingUserId, school_id: 'synthetic-school',
    title: 'Собственное объявление для удаления аккаунта', description: 'Удаление проверяется только на синтетической базе', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: deletingImageKey, photo_status: 'pending', status: 'pending' });
  const accountDeletion = await listingsApi(apiRequest('DELETE', '/api/v1/me/account', 'synthetic-recent-registrant', {
    confirmation: 'УДАЛИТЬ МОЙ АККАУНТ',
  }));
  assert.deepEqual(accountDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 4 } });
  assert.ok(deletedMediaKeys.includes(deletingImageKey), 'account deletion removes all private objects under its owner prefix');
  assert.ok(deletedMediaKeys.includes(attachedIdeaImageKey), 'account deletion removes linked idea photos');
  assert.ok(deletedMediaKeys.includes(rejectedIdeaImageKey), 'account deletion removes rejected idea photos awaiting orphan cleanup');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-2' }), null,
    'account deletion removes the identity mapping after cleanup');
  assert.equal((await sql`SELECT id FROM fam_listings WHERE id = ${deletingListing.id};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE object_key = ${deletingImageKey};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT idea_id FROM fam_idea_images WHERE user_id = ${deletingUserId};`)?.[0]?.length ?? 0, 0,
    'account deletion removes private idea image references');
  const requestedTargetId = '99999999-9999-4999-8999-999999999999';
  const requestedImageKey = `pending/${requestedTargetId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp`;
  accountMediaKeys.add(requestedImageKey);
  await repo.registerPendingImage(requestedTargetId, requestedImageKey);
  const requestedAvatarKey = `pending/${requestedTargetId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.webp`;
  accountMediaKeys.add(requestedAvatarKey);
  await repo.registerPendingImage(requestedTargetId, requestedAvatarKey);
  await sql`INSERT INTO fam_avatar_reviews (id, user_id, school_id, image_key, status, created_at, reviewed_by, reviewed_at)
    VALUES ('eeeeeeee-0000-4000-8000-000000000001', ${requestedTargetId}, 'synthetic-school', ${requestedAvatarKey}, 'pending', CurrentUtcTimestamp(), '', NULL);`;
  await sql`INSERT INTO fam_notification_reads (user_id, notification_key, read_at)
    VALUES (${requestedTargetId}, 'synthetic-notification', CurrentUtcTimestamp());`;
  await sql`INSERT INTO fam_submission_quotas (user_id, action, window_start, submission_count)
    VALUES (${requestedTargetId}, 'listing', CurrentUtcTimestamp(), Unwrap(CAST(1 AS Uint32)));`;
  const deletionAuditId = 'eeeeeeee-0000-4000-8000-000000000002';
  await sql`INSERT INTO fam_school_content_audit (event_id, school_id, actor_id, entity_id, entity_type, action, details, created_at)
    VALUES (${deletionAuditId}, 'synthetic-school', ${requestedTargetId}, 'synthetic-entity', 'listing', 'synthetic_review', '{}', CurrentUtcTimestamp());`;
  const deletionSafetyFingerprint = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const deletionSafetyId = 'eeeeeeee-0000-4000-8000-000000000003';
  await sql`INSERT INTO fam_safety_incidents (school_id, pair_fingerprint, source_kind, category, incident_id, severity,
    created_at, reviewed_at, reviewed_by, actor_id, target_id, source_origin, evidence_excerpt)
    VALUES ('synthetic-school', ${deletionSafetyFingerprint}, 'message', 'targeted_harassment', ${deletionSafetyId}, 'medium',
      CurrentUtcTimestamp(), NULL, NULL, ${requestedTargetId}, '33333333-3333-4333-8333-333333333333', 'fam.example.ru', 'sanitized synthetic evidence');`;
  const requestedDeletion = await listingsApi(apiRequest('POST', '/api/v1/deletion-requests', 'synthetic-council', {
    target_id: requestedTargetId, reason_code: 'spam', reason: 'Repeated unrelated messages in the synthetic school test.',
  }));
  assert.equal(requestedDeletion.status, 202);
  const approvedDeletion = await listingsApi(apiRequest('PATCH', `/api/v1/deletion-requests/${requestedDeletion.body.request_id}`, 'synthetic-admin', {    decision: 'approve', confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА', review_note: 'Подтверждено синтетическим тестом',
  }));
  assert.deepEqual(approvedDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 2 } });
  assert.ok(deletedMediaKeys.includes(requestedImageKey), 'approved deletion removes private media for the requested synthetic account');
  assert.ok(deletedMediaKeys.includes(requestedAvatarKey), 'approved deletion also removes a linked avatar object');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-delete-target' }), null,
    'approved deletion removes the requested profile identity mapping');
  assert.equal((await sql`SELECT id FROM fam_avatar_reviews WHERE user_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT notification_key FROM fam_notification_reads WHERE user_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0);
  assert.equal((await sql`SELECT action FROM fam_submission_quotas WHERE user_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0);
  const anonymizedAudit = await sql`SELECT actor_id FROM fam_school_content_audit WHERE event_id = ${deletionAuditId};`;
  assert.equal(anonymizedAudit?.[0]?.[0]?.actor_id, 'deleted-account');
  const anonymizedSafety = await sql`SELECT actor_id, target_id, source_origin, evidence_excerpt FROM fam_safety_incidents
    WHERE school_id = 'synthetic-school' AND pair_fingerprint = ${deletionSafetyFingerprint} AND incident_id = ${deletionSafetyId};`;
  assert.deepEqual(anonymizedSafety?.[0]?.[0], { actor_id: null, target_id: null, source_origin: null, evidence_excerpt: null });
  const approvedRequest = await sql`SELECT status, reviewed_by, review_note FROM fam_account_deletion_requests WHERE request_id = ${requestedDeletion.body.request_id};`;
  assert.deepEqual(approvedRequest[0][0], { status: 'approved', reviewed_by: '33333333-3333-4333-8333-333333333333', review_note: 'Подтверждено синтетическим тестом' });
  assert.equal((await sql`SELECT request_id FROM fam_account_deletion_open WHERE target_id = ${requestedTargetId};`)?.[0]?.length ?? 0, 0,
    'approved deletion closes the unique open request while retaining the decision record');
  const adminDeleteTargetId = '77777777-7777-4777-8777-777777777777';
  const adminDeleteImageKey = `pending/${adminDeleteTargetId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.webp`;
  accountMediaKeys.add(adminDeleteImageKey);
  await repo.registerPendingImage(adminDeleteTargetId, adminDeleteImageKey);
  const adminDeleteListing = await repo.createListing({ user_id: adminDeleteTargetId, school_id: 'synthetic-school',
    title: 'Объявление аккаунта для административного удаления', description: 'Синтетическая YDB проверка', category: 'Учёба',
    price_text: 'Бесплатно', is_event: false, max_seats: 0, image_key: adminDeleteImageKey, photo_status: 'pending', status: 'pending' });
  const adminDeletion = await listingsApi(apiRequest('DELETE', `/api/v1/school/accounts/${adminDeleteTargetId}`, 'synthetic-admin', {
    confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА',
  }));
  assert.deepEqual(adminDeletion, { status: 200, body: { ok: true, deleted: true, removed_images: 1 } });
  assert.ok(deletedMediaKeys.includes(adminDeleteImageKey), 'direct school-admin deletion removes the eligible synthetic target private image');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-role-target' }), null,
    'direct school-admin deletion removes only the same-school student identity mapping');
  assert.equal((await sql`SELECT id FROM fam_listings WHERE id = ${adminDeleteListing.id};`)?.[0]?.length ?? 0, 0);
  const adminDeleteAudit = await sql`SELECT action, previous_role FROM fam_school_admin_audit WHERE target_id = ${adminDeleteTargetId};`;
  assert.deepEqual(adminDeleteAudit[0], [{ action: 'account_deleted', previous_role: 'student' }],
    'administrator deletion is preserved in the audit after the profile is removed');
  const recoveryUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
  const recoveryImageKey = `pending/${recoveryUserId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`;
  accountMediaKeys.add(recoveryImageKey);
  await repo.registerPendingImage(recoveryUserId, recoveryImageKey);
  const startedRecovery = await repo.beginAccountDeletion({ issuer: 'https://issuer.synthetic', subject: 'subject-recovery', userId: recoveryUserId });
  assert.equal(startedRecovery.ok, true);
  await sql`UPDATE fam_account_deletion_jobs SET claim_until = Unwrap(CurrentUtcTimestamp() - Interval('PT1M')) WHERE user_id = ${recoveryUserId};`;
  const recoverAccountDeletions = createAccountDeletionRecoveryOperation({ repository: repo, pendingImages: {
    listUserObjects: async userId => [...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)),
      listAccountObjects: async (userId, ownedKeys = []) => [...new Set([
        ...[...accountMediaKeys].filter(key => key.startsWith(`pending/${userId}/`)), ...ownedKeys,
      ])],
    delete: async key => { deletedMediaKeys.push(key); accountMediaKeys.delete(key); },
  } });
  assert.deepEqual(await recoverAccountDeletions(10), { claimed: 1, completed: 1, failed: 0 },
    'a durable account deletion job can be resumed after its lease expires');
  assert.equal(await resolveActor({ issuer: 'https://issuer.synthetic', subject: 'subject-recovery' }), null,
    'manual recovery removes the synthetic account identity after deleting private media');
  assert.equal((await sql`SELECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${recoveryUserId};`)?.[0]?.length ?? 0, 0);
  const quotaUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  const quotaListing = { user_id: quotaUserId, school_id: 'synthetic-school', title: 'Синтетическое объявление',    description: 'Проверка ограничения количества', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
    max_seats: 0, status: 'pending' };
  for (let i = 0; i < 5; i++) await repo.createListing(quotaListing);
  const listingQuotaState = await sql`SELECT action, submission_count, window_start FROM fam_submission_quotas WHERE user_id = ${quotaUserId};`;
  assert.equal(Number(listingQuotaState[0].find(row => row.action === 'listing')?.submission_count), 5,
    'the serializable counter records the five allowed listings');
  assert.deepEqual(await repo.createListing(quotaListing), { ok: false, code: 'rate_limited' },
    'the sixth listing in one hour is rejected for this synthetic account');
  const quotaAvatarKey = `pending/${quotaUserId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
  await repo.registerPendingImage(quotaUserId, quotaAvatarKey);
  privateObjects.set(quotaAvatarKey, { body: Buffer.from('synthetic-webp'), contentType: 'image/webp' });
  quotaPendingImages = createS3PendingImageStore({
    FAM_RU_S3_ENDPOINT: 'http://127.0.0.1:9000', FAM_RU_S3_BUCKET: 'synthetic-private',
    FAM_RU_S3_ACCESS_KEY_ID: 'synthetic-access', FAM_RU_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
  }, {
    send: async input => { privateObjects.set(input.Key, { body: Buffer.from(input.Body), contentType: input.ContentType }); },
    get: async input => {
      const object = privateObjects.get(input.Key);
      return object ? { ContentType: object.contentType, ContentLength: object.body.length,
        Body: { transformToByteArray: async () => object.body } } : null;
    },
    remove: async input => { privateObjects.delete(input.Key); },
  });
  const quotaAvatarApi = createListingsApi({ authenticate: async () => ({ issuer: 'https://issuer.synthetic', subject: 'quota-avatar-user' }),
    resolveActor: async () => ({ id: quotaUserId, school_id: 'synthetic-school', role: 'student' }), repository: repo,
    pendingImages: quotaPendingImages });
  const quotaAvatarResponse = await quotaAvatarApi(apiRequest('POST', '/api/v1/me/avatar', 'quota-avatar', { image_key: quotaAvatarKey }));
  assert.equal(quotaAvatarResponse.status, 429, 'avatar submission shares the exhausted listing quota');
  assert.equal(privateObjects.has(quotaAvatarKey), false, 'the rejected avatar object is removed from private storage');
  const quotaAvatarState = await sql`SELECT status FROM fam_pending_media WHERE object_key = ${quotaAvatarKey} LIMIT 1;`;
  assert.equal(quotaAvatarState[0].length, 0, 'the rejected avatar registration is removed through the cleanup lease');
  const rejectedAvatar = await sql`SELECT id FROM fam_avatar_reviews WHERE user_id = ${quotaUserId} AND status = 'pending';`;
  assert.equal(rejectedAvatar[0].length, 0, 'a rate-limited avatar is not queued for review');
  const quotaIdea = { user_id: quotaUserId, school_id: 'synthetic-school', text: 'Синтетическая идея',
    ai_status: 'pending', ai_summary: 'Идея', ai_reason: 'review_unavailable', admin_status: 'new' };
  for (let i = 0; i < 5; i++) await repo.createIdea(quotaIdea);
  assert.deepEqual(await repo.createIdea(quotaIdea), { ok: false, code: 'rate_limited' },
    'the sixth idea in one hour is rejected for this synthetic account');
  for (let i = 0; i < 5; i++) await repo.reserveImageUpload(quotaUserId);
  assert.equal(await repo.reserveImageUpload(quotaUserId), false,
    'a sixth image decode reservation in one hour is rejected for this synthetic account');
  const quotaRows = await sql`SELECT action, submission_count FROM fam_submission_quotas WHERE user_id = ${quotaUserId};`;
  assert.deepEqual(Object.fromEntries(quotaRows[0].map(row => [row.action, Number(row.submission_count)])), { idea: 5, image_upload: 5, listing: 5 });
  const indexProbes = await Promise.all([
    sql`SELECT id FROM fam_avatar_reviews VIEW fam_avatar_reviews_user_id_idx WHERE user_id = ${quotaUserId};`,
    sql`SELECT announcement_id FROM fam_school_announcements VIEW fam_school_announcements_author_id_idx WHERE author_id = ${quotaUserId};`,
    sql`SELECT poll_id FROM fam_school_polls VIEW fam_school_polls_author_id_idx WHERE author_id = ${quotaUserId};`,
    sql`SELECT choice_index FROM fam_school_poll_votes VIEW fam_school_poll_votes_voter_id_idx WHERE voter_id = ${quotaUserId};`,
  ]);
  assert.ok(indexProbes.every(rows => (rows?.[0]?.length ?? 0) === 0), 'all four FK lookup indexes are usable on the empty synthetic tables');
  const agentQueue = createYdbAgentTaskQueue(sql);
  const coderBucket = new Date();
  coderBucket.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 3; i++) {
    await repo.recordSiteError({ eventCode: 'js_runtime', pageArea: 'auth', occurredAt: new Date(coderBucket.getTime() + i * 60_000) });
  }
  const coderSlotDate = new Date();
  coderSlotDate.setUTCMinutes(Math.floor(coderSlotDate.getUTCMinutes() / 15) * 15, 0, 0);
  const coderSlot = coderSlotDate.toISOString().slice(0, 16);
  const coderTask = await agentQueue.enqueueSafeCoderTask(coderSlot);
  assert.equal(coderTask.created, true, 'thresholded aggregate telemetry creates a synthetic manual-review task');
  assert.equal(coderTask.task_key, 'audit_frontend_runtime');
  const initialCoderQueueHealth = await agentQueue.getAgentTaskQueueHealth();
  assert.equal(initialCoderQueueHealth.queued, 1);
  assert.equal(initialCoderQueueHealth.claimed, 0);
  assert.deepEqual(Object.keys(initialCoderQueueHealth).sort(),
    ['claimed', 'expired_leases', 'failed_last_24h', 'in_progress', 'oldest_queued_minutes', 'queued']);
  assert.equal((await agentQueue.enqueueSafeCoderTask(coderSlot)).created, false, 'coder task enqueue is idempotent per quarter-hour slot');
  const claimedBeforeCoder = await agentQueue.claimSafeTasks(5);
  assert.equal(claimedBeforeCoder.some(task => task.task_type === 'coder_patch_request'), false,
    'the automated worker allowlist never claims coder tasks');
  const queuedCoder = await sql`SELECT status, payload_json FROM fam_agent_tasks WHERE id = ${coderTask.id};`;
  assert.equal(queuedCoder?.[0]?.[0]?.status, 'queued', 'coder task stays out of the automated safe worker');
  const coderPayload = JSON.parse(queuedCoder?.[0]?.[0]?.payload_json ?? 'null');
  assert.deepEqual(Object.keys(coderPayload).sort(), ['event_code', 'occurrences', 'page_area', 'task_key'],
    'coder task carries only the fixed aggregate schema');
  assert.equal(coderPayload.task_key, coderTask.task_key);
  assert.ok(['js_runtime', 'unhandled_rejection', 'listings_load_failed'].includes(coderPayload.event_code));
  assert.ok(['auth', 'listings', 'notifications', 'database', 'other'].includes(coderPayload.page_area));
  assert.ok(Number.isInteger(coderPayload.occurrences) && coderPayload.occurrences >= 3 && coderPayload.occurrences <= 1000);
  const coderClaim = await agentQueue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
  assert.equal(coderClaim.id, coderTask.id);
  assert.equal(coderClaim.task_key, coderPayload.task_key);
  const claimedCoderQueueHealth = await agentQueue.getAgentTaskQueueHealth();
  assert.equal(claimedCoderQueueHealth.queued, 0);
  assert.equal(claimedCoderQueueHealth.claimed, 1);
  assert.equal(await agentQueue.finishSafeCoderTask({ id: coderClaim.id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: coderClaim.claim_token, resultCode: 'model_no_patch' }), true);
  assert.equal(await agentQueue.finishSafeCoderTask({ id: coderClaim.id, workerId: 'fam-agent-qwen-coder-v1',
    claimToken: coderClaim.claim_token, resultCode: 'model_no_patch' }), false, 'finished coder leases cannot be replayed');
  await sql`DELETE FROM fam_site_error_counts
    WHERE hour_bucket = Unwrap(CAST(${coderBucket.toISOString()} AS Timestamp))
      AND event_code = 'js_runtime' AND page_area = 'auth';`;
  for (const [index, [eventCode, pageArea, taskKey]] of [
    ['notifications_load_failed', 'notifications', 'audit_client_resilience'],
    ['database_request_failed', 'database', 'audit_client_resilience'],
    ['auth_backend_failed', 'auth', 'audit_client_resilience'],
  ].entries()) {
    await sql`DELETE FROM fam_site_error_counts WHERE event_code IN
      ('js_runtime', 'unhandled_rejection', 'listings_load_failed', 'notifications_load_failed',
        'database_request_failed', 'auth_backend_failed');`;
    const eventBucket = new Date();
    eventBucket.setUTCMinutes(0, 0, 0);
    await sql`UPSERT INTO fam_site_error_counts
      (hour_bucket, event_code, page_area, event_count, created_at, updated_at)
      VALUES (Unwrap(CAST(${eventBucket.toISOString()} AS Timestamp)), ${eventCode}, ${pageArea},
        Unwrap(CAST(3 AS Uint32)), CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
    const followupSlotDate = new Date(coderSlotDate.getTime() + (index + 1) * 15 * 60 * 1000);
    const followupTask = await agentQueue.enqueueSafeCoderTask(followupSlotDate.toISOString().slice(0, 16));
    assert.equal(followupTask.created, true, `${eventCode} aggregate creates a synthetic coder review task`);
    assert.equal(followupTask.task_key, taskKey, `${eventCode} maps to its fixed task key`);
    const followupPayloadRows = await sql`SELECT status, payload_json FROM fam_agent_tasks WHERE id = ${followupTask.id} LIMIT 1;`;
    assert.equal(followupPayloadRows?.[0]?.[0]?.status, 'queued',
      'new coder task remains outside the automated safe-worker allowlist');
    const followupPayload = JSON.parse(followupPayloadRows?.[0]?.[0]?.payload_json ?? 'null');
    assert.deepEqual(followupPayload, { task_key: taskKey, event_code: eventCode, page_area: pageArea, occurrences: 3 });
    const followupClaim = await agentQueue.claimSafeCoderTask({ workerId: 'fam-agent-qwen-coder-v1', leaseSeconds: 7200 });
    assert.equal(followupClaim.id, followupTask.id);
    assert.equal(followupClaim.event_code, eventCode);
    assert.equal(await agentQueue.finishSafeCoderTask({ id: followupClaim.id, workerId: 'fam-agent-qwen-coder-v1',
      claimToken: followupClaim.claim_token, resultCode: 'model_no_patch' }), true);
    await sql`DELETE FROM fam_site_error_counts
      WHERE hour_bucket = Unwrap(CAST(${eventBucket.toISOString()} AS Timestamp))
        AND event_code = ${eventCode} AND page_area = ${pageArea};`;
  }
  const safeTask = await agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:00');
  assert.equal(safeTask.created, true);
  assert.equal((await agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:00')).created, false,
    'safe scheduled task enqueue is idempotent');
  const claimedSafeTasks = await agentQueue.claimSafeTasks(1);
  assert.equal(claimedSafeTasks.length, 1);
  assert.equal(claimedSafeTasks[0].task_type, 'queue_health_check');
  assert.equal(Object.hasOwn(claimedSafeTasks[0], 'payload'), false, 'worker claim does not expose arbitrary task payload');
  assert.equal(await agentQueue.finishSafeTask({ id: claimedSafeTasks[0].id, claimToken: claimedSafeTasks[0].claim_token,
    status: 'completed', summary: 'Synthetic aggregate queue check completed.' }), true);
  assert.equal(await agentQueue.finishSafeTask({ id: claimedSafeTasks[0].id, claimToken: claimedSafeTasks[0].claim_token,
    status: 'completed', summary: 'Stale claim must not complete.' }), false, 'finished claims cannot be replayed');
  const safeQueueHealth = await agentQueue.getSafeTaskQueueHealth();
  assert.equal(safeQueueHealth.statuses.completed, 1);
  assert.equal(safeQueueHealth.content_read, false);
  const concurrentEnqueues = await Promise.all([
    agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:15'),
    agentQueue.enqueueSafeTask('queue_health_check', '2026-11-20T03:15'),
  ]);
  assert.equal(concurrentEnqueues.filter(result => result.created).length, 1,
    'concurrent idempotent enqueues create one task');
  const concurrentClaims = await Promise.all([agentQueue.claimSafeTasks(1), agentQueue.claimSafeTasks(1)]);
  assert.equal(concurrentClaims.reduce((total, tasks) => total + tasks.length, 0), 1,
    'a concurrent worker cannot claim the same task twice');
  const racedClaim = concurrentClaims.flat()[0];
  assert.equal(await agentQueue.finishSafeTask({ id: racedClaim.id, claimToken: racedClaim.claim_token,
    status: 'completed', summary: 'Concurrent synthetic claim completed once.' }), true);
  const syntheticSystemHealth = createSystemHealthTaskHandler({
    readinessCheck: async () => ({ ready: true, services: { auth: true, database: true, objectStorage: true } }),
    timerCheck: async () => ({ ok: true, timers: [{ unit: 'fam-ru-synthetic.timer', ok: true }] }),
    queueHealthCheck: async () => {
      const health = await repo.getRuBackgroundQueueHealth();
      const safeTasks = await agentQueue.getSafeTaskQueueHealth();
      return { ...health, queues: { ...health.queues, safe_agent_tasks: safeTasks }, content_read: false };
    },
    schemaCheck: async () => schemaHealth,
  });
  const scheduledWorker = createSafeAgentTaskWorker({ queue: agentQueue, handlers: {
    queue_health_check: async () => {
      const health = await agentQueue.getSafeTaskQueueHealth();
      return `Синтетическая проверка очередей: ожидают ${health.statuses.queued}; содержимое не читалось.`;
    },
    daily_report_digest: async () => {
      const result = await createOrchestratorDailyDigest({ repository: repo, now: () => new Date('2026-11-20T04:00:00.000Z') })();
      return `Синтетическая сводка за ${result.date} обработана агрегированно.`;
    },
    system_health_check: syntheticSystemHealth,
    site_error_digest: async () => {
      const result = await createSiteErrorDigest({ repository: repo, now: () => new Date('2026-11-20T04:30:00.000Z') })();
      return `Синтетическая сводка ошибок за ${result.slot} обработана агрегированно.`;
    },
  } });
  const scheduledRuns = [];
  for (const slot of ['2026-11-20T03:40:00.000Z', '2026-11-20T04:00:00.000Z', '2026-11-20T04:30:00.000Z']) {
    scheduledRuns.push(await createScheduledSafeAgentRunner({ queue: agentQueue, worker: scheduledWorker,
      now: () => new Date(slot) })());
  }
  assert.deepEqual(scheduledRuns.map(result => ({ scheduled: result.scheduled, created: result.created,
    claimed: result.claimed, completed: result.completed, blocked: result.blocked, failed: result.failed })), [
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
    { scheduled: 1, created: 1, claimed: 1, completed: 1, blocked: 0, failed: 0 },
  ], 'all three source schedule slots enqueue and complete through the real YDB queue and safe worker');
  const scheduledRows = await sql`SELECT task_type, status FROM fam_agent_tasks WHERE source = 'scheduled_audit'
    AND task_type IN ('system_health_check', 'daily_report_digest', 'site_error_digest');`;
  assert.deepEqual(new Set((scheduledRows?.[0] ?? []).map(row => `${row.task_type}:${row.status}`)),
    new Set(['system_health_check:completed', 'daily_report_digest:completed', 'site_error_digest:completed']));
  console.log('YDB_LOCAL_INTEGRATION_PASS: school profile/role/deletion requests, same-school account and listing deletion, school content/polls, own-profile identity, private media cleanup, manual school-scoped avatar review and approval, aggregate agent reports and school-bound idea review, allowlisted hourly error telemetry, idempotent concurrent enqueue and exclusive lease-based safe agent queue, 03:40/04:00/hourly :30 UTC schedule-to-worker flows with synthetic health checks and real digest handlers, persistent hourly listing/idea/image-upload quotas, four secondary lookup indexes, listings, favorites, ideas, messages, events, all on disposable synthetic local database');
} catch (error) {
  console.error(inspect(error, { depth: null }));
  process.exitCode = 1;
} finally {
  syntheticPendingImages?.close();
  quotaPendingImages?.close();
  await driver.close();
}
