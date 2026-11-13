import { createPublicKey, verify as verifySignature } from 'node:crypto';

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}
function safeUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new TypeError(`${label} must use HTTPS`);
  if (url.username || url.password || url.hash) throw new TypeError(`${label} is invalid`);
  return url;
}

export function createOidcBearerAuthenticator({ issuer, audience, jwksUri, fetchImpl = fetch, clock = () => Date.now(), cacheMs = 300_000 }) {
  if (typeof audience !== 'string' || !audience) throw new TypeError('OIDC audience is required');
  const issuerUrl = safeUrl(issuer, 'OIDC issuer').href.replace(/\/$/, '');
  const keysUrl = safeUrl(jwksUri, 'OIDC JWKS URL');
  let cachedKeys = null;
  let cachedAt = 0;
  return async function authenticate(request) {
    const auth = request.headers?.authorization || request.headers?.get?.('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(auth);
    if (!match || match[1].length > 16_384) return null;
    const parts = match[1].split('.');
    if (parts.length !== 3) return null;
    try {
      const header = decodeJson(parts[0]);
      const claims = decodeJson(parts[1]);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;
      if (claims.iss !== issuerUrl || !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience)))) return null;
      const now = Math.floor(clock() / 1000);
      if (!Number.isFinite(claims.exp) || claims.exp <= now || (Number.isFinite(claims.nbf) && claims.nbf > now + 5)) return null;
      if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256) return null;
      if (!cachedKeys || clock() - cachedAt > cacheMs) {
        const response = await fetchImpl(keysUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        const body = await response.json();
        if (!Array.isArray(body.keys)) return null;
        cachedKeys = body.keys.filter((key) => key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
        cachedAt = clock();
      }
      const jwk = cachedKeys.find((key) => key.kid === header.kid);
      if (!jwk) return null;
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      const signed = `${parts[0]}.${parts[1]}`;
      if (!verifySignature('RSA-SHA256', Buffer.from(signed), publicKey, Buffer.from(parts[2], 'base64url'))) return null;
      // Do not return role/email claims. Callers must load authorization from the database.
      return Object.freeze({ subject: claims.sub, issuer: claims.iss });
    } catch {
      return null;
    }
  };
}
