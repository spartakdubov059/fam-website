import { createHmac, randomInt } from 'node:crypto';

const CODE_SECONDS = 10 * 60;

function normalizedEmail(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

function digest(key, ...parts) {
  return createHmac('sha256', key).update(parts.join('\0')).digest('hex');
}

export function createStepUpEmailVerification({ repository, verificationKey, sendEmail, now = Date.now,
  createCode = () => String(randomInt(100000, 1_000_000)) } = {}) {
  if (typeof now !== 'function' || typeof createCode !== 'function') throw new TypeError('invalid step-up verification clock');
  const key = typeof verificationKey === 'string' || Buffer.isBuffer(verificationKey) ? Buffer.from(verificationKey) : Buffer.alloc(0);
  const configured = key.length >= 32 && typeof sendEmail === 'function'
    && typeof repository?.startStepUpEmailChallenge === 'function'
    && typeof repository?.verifyStepUpEmailChallenge === 'function'
    && typeof repository?.clearStepUpEmailChallenge === 'function';

  function valuesFor(identity) {
    const email = normalizedEmail(identity?.email);
    if (!email || typeof identity?.issuer !== 'string' || !identity.issuer
        || typeof identity?.subject !== 'string' || !identity.subject) return null;
    const emailDigest = digest(key, 'step-up-email', identity.issuer, identity.subject, email);
    return { email, emailDigest };
  }

  return Object.freeze({
    get available() { return configured; },
    async start(identity, accessToken) {
      if (!configured) return { ok: false, code: 'step_up_unavailable' };
      const values = valuesFor(identity);
      if (!values) return { ok: false, code: 'verified_email_required' };
      if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096) {
        return { ok: false, code: 'email_delivery_unavailable' };
      }
      const code = createCode();
      if (!/^\d{6}$/.test(code)) throw new TypeError('step-up code generator returned an invalid code');
      const currentSeconds = Math.floor(now() / 1000);
      const codeDigest = digest(key, 'step-up-code', identity.issuer, identity.subject, values.emailDigest, code);
      const reserved = await repository.startStepUpEmailChallenge({ issuer: identity.issuer, subject: identity.subject,
        emailDigest: values.emailDigest, codeDigest, currentSeconds, expiresSeconds: currentSeconds + CODE_SECONDS });
      if (!reserved?.ok) return reserved || { ok: false, code: 'database_unavailable' };
      try {
        await sendEmail({ to: values.email, code, accessToken, purpose: 'step_up' });
        return { ok: true, sent: true };
      } catch {
        try { await repository.clearStepUpEmailChallenge({ issuer: identity.issuer, subject: identity.subject, codeDigest }); }
        catch { /* the challenge expires after ten minutes */ }
        return { ok: false, code: 'email_delivery_unavailable' };
      }
    },
    async verify(identity, code) {
      if (!configured) return { ok: false, code: 'step_up_unavailable' };
      const values = valuesFor(identity);
      if (!values) return { ok: false, code: 'verified_email_required' };
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, code: 'invalid_verification_code' };
      const codeDigest = digest(key, 'step-up-code', identity.issuer, identity.subject, values.emailDigest, code);
      const result = await repository.verifyStepUpEmailChallenge({ issuer: identity.issuer, subject: identity.subject,
        emailDigest: values.emailDigest, codeDigest, currentSeconds: Math.floor(now() / 1000) });
      if (!result?.ok || !Number.isSafeInteger(result.issued_seconds) || !Number.isSafeInteger(result.confirmed_at)
          || result.confirmed_at < result.issued_seconds || result.confirmed_at - result.issued_seconds > CODE_SECONDS) {
        return result || { ok: false, code: 'database_unavailable' };
      }
      return result;
    },
  });
}
