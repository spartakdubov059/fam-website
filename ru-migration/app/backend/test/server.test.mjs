import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('isolated server serves the local FAM RU shell and its price formatter without remote SDKs', async () => {
  await withServer({}, async origin => {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /FAM RU — подготовка/);
    assert.match(html, /src="\/price-format\.js"/);
    assert.doesNotMatch(html, /https:\/\/[^"']+\.supabase\.co/);

    const formatter = await fetch(new URL('/price-format.js', origin));
    assert.equal(formatter.status, 200);
    assert.match(formatter.headers.get('content-type'), /javascript/);
    assert.match(await formatter.text(), /formatListingPrice/);
  });
});

test('unconfigured isolated server fails closed for health and user API routes', async () => {
  await withServer({}, async origin => {
    const health = await fetch(new URL('/api/health', origin));
    assert.equal(health.status, 503);
    assert.equal((await health.json()).mode, 'isolated-copy');

    const api = await fetch(new URL('/api/v1/listings', origin));
    assert.equal(api.status, 503);
    assert.equal((await api.json()).error, 'backend_not_configured');
  });
});

test('isolated server routes favorite API requests to the authenticated backend', async () => {
  const routed = [];
  await withServer({ listingsApi: async request => {
    routed.push({ method: request.method, url: request.url });
    return { status: 200, body: { ok: true, favorited: request.method === 'PUT' } };
  } }, async origin => {
    const id = '11111111-1111-4111-8111-111111111111';
    const put = await fetch(new URL(`/api/v1/listings/${id}/favorite`, origin), { method: 'PUT' });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, favorited: true });
    const list = await fetch(new URL('/api/v1/favorites', origin));
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { ok: true, favorited: false });
    const idea = await fetch(new URL('/api/v1/ideas', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'synthetic' }) });
    assert.equal(idea.status, 200);
    assert.deepEqual(await idea.json(), { ok: true, favorited: false });
  });
  assert.deepEqual(routed, [
    { method: 'PUT', url: `/api/v1/listings/11111111-1111-4111-8111-111111111111/favorite` },
    { method: 'GET', url: '/api/v1/favorites' },
    { method: 'POST', url: '/api/v1/ideas' },
  ]);
});
