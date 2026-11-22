import { createHmac, timingSafeEqual } from 'node:crypto';

const STEP_UP_SECONDS = 10 * 60;

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function encodeSigned(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function decodeSigned(value, secret) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function getCookie(req, name) {
  const raw = req?.headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

export function createStepUpCookie({ secret, secure = true, now = Date.now } = {}) {
  const key = typeof secret === 'string' || Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.alloc(0);
  if (key.length < 32 || typeof now !== 'function') throw new TypeError('step-up cookie secret and clock are required');
  const name = secure ? '__Host-fam_ru_step_up' : 'fam_ru_step_up';

  function issue(identity) {
    if (!identity?.issuer || !identity?.subject) throw new TypeError('verified identity is required');
    const confirmedAt = Math.floor(now() / 1000);
    const value = encodeSigned({ kind: 'step_up', issuer: identity.issuer, subject: identity.subject,
      confirmed_at: confirmedAt, exp: confirmedAt + STEP_UP_SECONDS }, key);
    const setCookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${STEP_UP_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    return { confirmedAt, setCookie };
  }

  function read(req, identity) {
    if (!identity?.issuer || !identity?.subject) return null;
    const value = decodeSigned(getCookie(req, name), key);
    const nowSeconds = Math.floor(now() / 1000);
    if (!value || value.kind !== 'step_up' || value.issuer !== identity.issuer || value.subject !== identity.subject
        || !Number.isSafeInteger(value.confirmed_at) || !Number.isSafeInteger(value.exp)
        || value.exp !== value.confirmed_at + STEP_UP_SECONDS || value.confirmed_at > nowSeconds + 5
        || value.confirmed_at < nowSeconds - STEP_UP_SECONDS || value.exp <= nowSeconds) return null;
    return value.confirmed_at;
  }

  return Object.freeze({ issue, read });
}
