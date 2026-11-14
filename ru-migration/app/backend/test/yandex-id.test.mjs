import test from 'node:test';
import assert from 'node:assert/strict';
import { createYandexIdAuth } from '../auth/yandex-id.mjs';

function cookiePair(header) { return header.split(';', 1)[0]; }
function cookieValue(header) { return decodeURIComponent(cookiePair(header).split('=').slice(1).join('=')); }
function callbackRequest(state, stateCookie, code = 'synthetic-code') {
  return { method: 'GET', url: `/auth/yandex/callback?${new URLSearchParams({ state, code })}`, headers: { cookie: stateCookie } };
}

test('Yandex ID login uses server-side PKCE, checks client identity, and issues only a short HttpOnly session', async () => {
  let currentTime = 1_800_000_000_000;
  const fetchCalls = [];
  const auth = createYandexIdAuth({ clientId: 'synthetic-client', redirectUri: 'https://fam.example/auth/yandex/callback', sessionSecret: 'test-session-secret-with-32-bytes-minimum', now: () => currentTime,
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url) === 'https://oauth.yandex.ru/token') return { ok: true, json: async () => ({ token_type: 'bearer', access_token: 'temporary-yandex-access-token', expires_in: 3600 }) };
      if (String(url) === 'https://login.yandex.ru/info?format=json') return { ok: true, json: async () => ({ id: '123456789', client_id: 'synthetic-client' }) };
      throw new Error('unexpected external URL');
    },
  });
  const start = await auth.handle({ method: 'GET', url: '/auth/yandex/start', headers: {} });
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.location);
  assert.equal(authorization.origin, 'https://oauth.yandex.ru');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), 'login:info');
  assert.equal(authorization.searchParams.has('force_confirm'), false);
  const stateCookie = cookiePair(start.headers['set-cookie']);
  const state = authorization.searchParams.get('state');
  const callback = await auth.handle(callbackRequest(state, stateCookie));
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, '/');
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].options.body.toString(), /code_verifier=/);
  assert.equal(new URL(fetchCalls[1].url).search, '?format=json', 'the OAuth token never appears in a URL');
  assert.equal(fetchCalls[1].options.headers.authorization, 'OAuth temporary-yandex-access-token');
  const sessionCookie = callback.headers['set-cookie'].find(value => value.startsWith('fam_ru_session='));
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /Secure/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.equal(sessionCookie.includes('temporary-yandex-access-token'), false);
  const identity = await auth.authenticate({ method: 'GET', headers: { cookie: cookiePair(sessionCookie) } });
  assert.deepEqual(identity, { issuer: 'https://login.yandex.ru', subject: '123456789', authenticated_at: 1_800_000_000 });
  assert.deepEqual(await auth.authenticate({ method: 'POST', headers: { cookie: cookiePair(sessionCookie), origin: 'https://fam.example' } }), identity);
  assert.equal(await auth.authenticate({ method: 'POST', headers: { cookie: cookiePair(sessionCookie), origin: 'https://attacker.example' } }), null);
  assert.equal(await auth.authenticate({ method: 'POST', headers: { cookie: cookiePair(sessionCookie) } }), null, 'unsafe cookie requests require an Origin header');
  currentTime += 3_601_000;
  assert.equal(await auth.authenticate({ method: 'GET', headers: { cookie: cookiePair(sessionCookie) } }), null, 'session expires after one hour');
});

test('sensitive-action reauthentication requests explicit Yandex account confirmation', async () => {
  const auth = createYandexIdAuth({ clientId: 'client', redirectUri: 'https://fam.example/auth/yandex/callback', sessionSecret: 'test-session-secret-with-32-bytes-minimum' });
  const start = await auth.handle({ method: 'GET', url: '/auth/yandex/start?reauth=1', headers: {} });
  const authorize = new URL(start.headers.location);
  assert.equal(authorize.searchParams.get('force_confirm'), 'yes');
  assert.match(start.headers['set-cookie'], /HttpOnly/);
});

test('Yandex logout rejects missing and cross-origin requests', async () => {
  const auth = createYandexIdAuth({ clientId: 'client', redirectUri: 'https://fam.example/auth/yandex/callback', sessionSecret: 'test-session-secret-with-32-bytes-minimum' });
  const missingOrigin = await auth.handle({ method: 'POST', url: '/auth/yandex/logout', headers: {} });
  const foreignOrigin = await auth.handle({ method: 'POST', url: '/auth/yandex/logout', headers: { origin: 'https://attacker.example' } });
  assert.equal(missingOrigin.status, 403);
  assert.equal(foreignOrigin.status, 403);
  const sameOrigin = await auth.handle({ method: 'POST', url: '/auth/yandex/logout', headers: { origin: 'https://fam.example' } });
  assert.equal(sameOrigin.status, 204);
  assert.match(sameOrigin.headers['set-cookie'], /Max-Age=0/);
});

test('Yandex callback rejects missing or mismatched OAuth state before contacting Yandex', async () => {
  let requests = 0;
  const auth = createYandexIdAuth({ clientId: 'client', redirectUri: 'http://localhost:4178/auth/yandex/callback', sessionSecret: 'test-session-secret-with-32-bytes-minimum', fetchImpl: async () => { requests++; throw new Error('must not contact Yandex'); } });
  const start = await auth.handle({ method: 'GET', url: '/auth/yandex/start', headers: {} });
  const cookie = cookiePair(start.headers['set-cookie']);
  const denied = await auth.handle(callbackRequest('different-state', cookie));
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.location, '/?auth_error=authorization_failed');
  assert.equal(requests, 0);
  const absentCookie = await auth.handle(callbackRequest('some-state', ''));
  assert.equal(absentCookie.status, 303);
  assert.equal(requests, 0);
});

test('Yandex profile must belong to the configured OAuth application', async () => {
  const auth = createYandexIdAuth({ clientId: 'expected-client', redirectUri: 'http://localhost:4178/auth/yandex/callback', sessionSecret: 'test-session-secret-with-32-bytes-minimum', fetchImpl: async url =>
    String(url) === 'https://oauth.yandex.ru/token'
      ? { ok: true, json: async () => ({ token_type: 'bearer', access_token: 'token' }) }
      : { ok: true, json: async () => ({ id: '12345', client_id: 'other-client' }) },
  });
  const start = await auth.handle({ method: 'GET', url: '/auth/yandex/start', headers: {} });
  const authorization = new URL(start.headers.location);
  const result = await auth.handle(callbackRequest(authorization.searchParams.get('state'), cookiePair(start.headers['set-cookie'])));
  assert.equal(result.headers.location, '/?auth_error=authorization_failed');
  assert.equal(result.headers['set-cookie'].startsWith('fam_ru_session='), false);
});

test('Yandex auth requires HTTPS off localhost and a strong session secret', () => {
  assert.throws(() => createYandexIdAuth({ clientId: 'client', redirectUri: 'http://fam.example/auth/yandex/callback', sessionSecret: 'test-session-secret-with-32-bytes-minimum' }), /HTTPS/);
  assert.throws(() => createYandexIdAuth({ clientId: 'client', redirectUri: 'https://fam.example/auth/yandex/callback', sessionSecret: 'short' }), /configuration/);
});
