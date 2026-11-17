import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOidcBearerAuthenticator } from '../auth/oidc-bearer.mjs';
const issuer = 'https://id.example.test';
const audience = 'fam-ru-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
function token(claims, alg = 'RS256') {
  const enc = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const input = `${enc({ alg, kid: 'synthetic-key' })}.${enc(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
function request(jwt) { return new Request('https://app.example.test/api', { headers: { authorization: `Bearer ${jwt}` } }); }
test('accepts a valid issuer/audience token and returns identity without role claims', async () => {
  const auth = createOidcBearerAuthenticator({ issuer, audience, jwksUri: `${issuer}/jwks`, fetchImpl: async () => Response.json({ keys: [jwk] }), clock: () => 2_000_000_000_000 });
  const claims = { iss: issuer, aud: audience, sub: 'synthetic-subject', exp: 2_000_000_1000, auth_time: 2_000_000_000, role: 'school_admin' };
  assert.deepEqual(await auth(request(token(claims))), { subject: 'synthetic-subject', issuer, authenticated_at: 2_000_000_000 });
  assert.equal((await auth(request(token(claims))).then(x => x)).role, undefined);
  const withoutAuthTime = { iss: issuer, aud: audience, sub: 'synthetic-subject', exp: 2_000_000_1000 };
  const unauthenticatedTimeIdentity = await auth(request(token(withoutAuthTime)));
  assert.equal(unauthenticatedTimeIdentity.authenticated_at, null);
});
test('rejects expired, wrong audience and non-RS256 tokens', async () => {
  const auth = createOidcBearerAuthenticator({ issuer, audience, jwksUri: `${issuer}/jwks`, fetchImpl: async () => Response.json({ keys: [jwk] }), clock: () => 2_000_000_000_000 });
  assert.equal(await auth(request(token({ iss: issuer, aud: audience, sub: 'u', exp: 1 }))), null);
  assert.equal(await auth(request(token({ iss: issuer, aud: 'other', sub: 'u', exp: 2_000_000_1000 }))), null);
  assert.equal(await auth(request(token({ iss: issuer, aud: audience, sub: 'u', exp: 2_000_000_1000 }, 'none'))), null);
});
test('does not trust unknown keys or fetch from non-HTTPS remote JWKS', async () => {
  const auth = createOidcBearerAuthenticator({ issuer, audience, jwksUri: `${issuer}/jwks`, fetchImpl: async () => Response.json({ keys: [] }), clock: () => 2_000_000_000_000 });
  assert.equal(await auth(request(token({ iss: issuer, aud: audience, sub: 'u', exp: 2_000_000_1000 }))), null);
  assert.throws(() => createOidcBearerAuthenticator({ issuer, audience, jwksUri: 'http://evil.example/jwks' }));
});
