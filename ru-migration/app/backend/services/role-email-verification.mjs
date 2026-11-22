import { createHmac, randomInt } from 'node:crypto';

function normalizedEmail(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

function digest(key, ...parts) {
  return createHmac('sha256', key).update(parts.join('\0')).digest('hex');
}

function validActor(identity, actor) {
  return Boolean(identity?.issuer && identity?.subject && actor?.id && actor?.school_id && actor.role === 'student');
}

export function createRoleEmailVerification({ repository, verificationKey, sendEmail, now = Date.now, createCode = () => String(randomInt(100000, 1_000_000)) }) {
  if (typeof now !== 'function' || typeof createCode !== 'function') throw new TypeError('invalid email verification clock');
  const key = typeof verificationKey === 'string' || Buffer.isBuffer(verificationKey) ? Buffer.from(verificationKey) : Buffer.alloc(0);
  const configured = key.length >= 32 && typeof sendEmail === 'function'
    && typeof repository?.startRoleEmailVerification === 'function'
    && typeof repository?.verifyRoleEmailVerification === 'function'
    && typeof repository?.isRoleEmailVerified === 'function';

  function identityDigests(identity) {
    const email = normalizedEmail(identity?.email);
    if (!email || !identity?.issuer || !identity?.subject) return null;
    const emailDigest = digest(key, 'email', identity.issuer, identity.subject, email);
    return { email, emailDigest };
  }

  return Object.freeze({
    get available() { return configured; },
    async isVerified(identity) {
      if (!configured) return false;
      const values = identityDigests(identity);
      if (!values) return false;
      return await repository.isRoleEmailVerified({ issuer: identity.issuer, subject: identity.subject, emailDigest: values.emailDigest }) === true;
    },
    async start(identity, actor, accessToken) {
      if (!validActor(identity, actor)) return { ok: false, code: 'student_profile_required' };
      if (!configured) return { ok: false, code: 'email_verification_unavailable' };
      const values = identityDigests(identity);
      if (!values) return { ok: false, code: 'verified_email_required' };
      if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096) {
        return { ok: false, code: 'email_delivery_unavailable' };
      }
      const code = createCode();
      if (!/^\d{6}$/.test(code)) throw new TypeError('email verification code generator returned an invalid code');
      const codeDigest = digest(key, 'code', identity.issuer, identity.subject, values.emailDigest, code);
      const currentSeconds = Math.floor(now() / 1000);
      const reserved = await repository.startRoleEmailVerification({ issuer: identity.issuer, subject: identity.subject,
        userId: actor.id, emailDigest: values.emailDigest, codeDigest, currentSeconds, expiresSeconds: currentSeconds + 600 });
      if (!reserved?.ok) return reserved || { ok: false, code: 'database_unavailable' };
      if (reserved.already_verified) return { ok: true, already_verified: true };
      try {
        await sendEmail({ to: values.email, code, accessToken });
        return { ok: true, sent: true };
      } catch {
        try { await repository.clearRoleEmailChallenge({ issuer: identity.issuer, subject: identity.subject, codeDigest }); } catch { /* an unsent code expires after ten minutes */ }
        return { ok: false, code: 'email_delivery_unavailable' };
      }
    },
    async verify(identity, actor, code) {
      if (!validActor(identity, actor)) return { ok: false, code: 'student_profile_required' };
      if (!configured) return { ok: false, code: 'email_verification_unavailable' };
      const values = identityDigests(identity);
      if (!values) return { ok: false, code: 'verified_email_required' };
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, code: 'invalid_verification_code' };
      const codeDigest = digest(key, 'code', identity.issuer, identity.subject, values.emailDigest, code);
      const result = await repository.verifyRoleEmailVerification({ issuer: identity.issuer, subject: identity.subject,
        userId: actor.id, emailDigest: values.emailDigest, codeDigest, currentSeconds: Math.floor(now() / 1000) });
      return result || { ok: false, code: 'database_unavailable' };
    },
  });
}
