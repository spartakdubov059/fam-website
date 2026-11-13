import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const YANDEX_ISSUER = 'https://login.yandex.ru';
const AUTHORIZATION_ENDPOINT = 'https://oauth.yandex.ru/authorize';
const TOKEN_ENDPOINT = 'https://oauth.yandex.ru/token';
const USERINFO_ENDPOINT = 'https://login.yandex.ru/info?format=json';
const SESSION_COOKIE = 'fam_ru_session';
const STATE_COOKIE = 'fam_ru_oauth_state';
const SESSION_SECONDS = 60 * 60;
const STATE_SECONDS = 10 * 60;

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function encodeSigned(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function decodeSigned(value, secret, nowSeconds) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && Number.isInteger(payload.exp) && payload.exp > nowSeconds ? payload : null;
  } catch { return null; }
}

function getCookie(req, name) {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function cookie(name, value, { path, maxAge, secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function createYandexIdAuth({ clientId, redirectUri, sessionSecret, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (typeof clientId !== 'string' || !clientId.trim() || typeof redirectUri !== 'string'
      || typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32 || typeof fetchImpl !== 'function') {
    throw new TypeError('complete Yandex ID auth configuration is required');
  }
  const callback = new URL(redirectUri);
  if (callback.pathname !== '/auth/yandex/callback' || callback.search || callback.hash) {
    throw new TypeError('Yandex ID redirect URI must use the /auth/yandex/callback path');
  }
  if (callback.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)) {
    throw new TypeError('Yandex ID redirect URI must use HTTPS outside localhost');
  }
  const secure = callback.protocol === 'https:';
  const secret = Buffer.from(sessionSecret);
  const nowSeconds = () => Math.floor(now() / 1000);

  async function handle(req) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/auth/yandex/logout') {
      return { status: 204, headers: { 'set-cookie': cookie(SESSION_COOKIE, '', { path: '/', maxAge: 0, secure }), 'cache-control': 'no-store' }, body: null };
    }
    if (req.method === 'GET' && url.pathname === '/auth/yandex/start') {
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const nowValue = nowSeconds();
      const stateToken = encodeSigned({ kind: 'oauth_state', state, verifier, exp: nowValue + STATE_SECONDS }, secret);
      const authorize = new URL(AUTHORIZATION_ENDPOINT);
      authorize.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: callback.toString(),
        scope: 'login:info', state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      return { status: 302, headers: {
        location: authorize.toString(),
        'set-cookie': cookie(STATE_COOKIE, stateToken, { path: callback.pathname, maxAge: STATE_SECONDS, secure }),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      }, body: null };
    }
    if (req.method === 'GET' && url.pathname === callback.pathname) {
      const stateToken = decodeSigned(getCookie(req, STATE_COOKIE), secret, nowSeconds());
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const clearState = cookie(STATE_COOKIE, '', { path: callback.pathname, maxAge: 0, secure });
      if (!stateToken || stateToken.kind !== 'oauth_state' || !returnedState || !code || returnedState !== stateToken.state) {
        return { status: 303, headers: { location: '/?auth_error=authorization_failed', 'set-cookie': clearState, 'cache-control': 'no-store' }, body: null };
      }
      try {
        const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback.toString(), code_verifier: stateToken.verifier }),
          signal: AbortSignal.timeout(5000),
        });
        if (!tokenResponse.ok) throw new Error('token_exchange_failed');
        const tokens = await tokenResponse.json();
        if (typeof tokens?.access_token !== 'string' || !tokens.access_token || tokens.token_type?.toLowerCase() !== 'bearer') throw new Error('invalid_token_response');
        const profileResponse = await fetchImpl(USERINFO_ENDPOINT, {
          headers: { accept: 'application/json', authorization: `OAuth ${tokens.access_token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!profileResponse.ok) throw new Error('userinfo_failed');
        const profile = await profileResponse.json();
        if (profile?.client_id !== clientId || typeof profile.id !== 'string' || !/^\d{1,40}$/.test(profile.id)) throw new Error('invalid_yandex_profile');
        const issued = nowSeconds();
        const session = encodeSigned({ kind: 'session', iss: YANDEX_ISSUER, sub: profile.id, iat: issued, exp: issued + SESSION_SECONDS }, secret);
        return { status: 303, headers: {
          location: '/',
          'set-cookie': [clearState, cookie(SESSION_COOKIE, session, { path: '/', maxAge: SESSION_SECONDS, secure })],
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        }, body: null };
      } catch {
        return { status: 303, headers: { location: '/?auth_error=authorization_failed', 'set-cookie': clearState, 'cache-control': 'no-store' }, body: null };
      }
    }
    return { status: 404, headers: { 'cache-control': 'no-store' }, body: { ok: false, error: 'not_found' } };
  }

  async function authenticate(req) {
    const session = decodeSigned(getCookie(req, SESSION_COOKIE), secret, nowSeconds());
    if (!session || session.kind !== 'session' || session.iss !== YANDEX_ISSUER || typeof session.sub !== 'string') return null;
    return { issuer: YANDEX_ISSUER, subject: session.sub };
  }

  return Object.freeze({ handle, authenticate });
}
