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
    assert.match(html, /auth\/yandex\/start/);
    assert.doesNotMatch(html, /https:\/\/[^"']+\.supabase\.co/);

    const formatter = await fetch(new URL('/price-format.js', origin));
    assert.equal(formatter.status, 200);
    assert.match(formatter.headers.get('content-type'), /javascript/);
    assert.match(await formatter.text(), /formatListingPrice/);

    const publicBoard = await fetch(new URL('/public-board.js', origin));
    assert.equal(publicBoard.status, 200);
    assert.match(publicBoard.headers.get('content-type'), /javascript/);
    assert.match(await publicBoard.text(), /api\/v1\/listings/);

    const boardStyles = await fetch(new URL('/public-board.css', origin));
    assert.equal(boardStyles.status, 200);
    assert.match(boardStyles.headers.get('content-type'), /text\/css/);
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

test('isolated server returns Yandex OAuth redirects without proxying credentials through the browser', async () => {
  await withServer({ authApi: async request => ({
    status: 302,
    headers: { location: 'https://oauth.yandex.ru/authorize?response_type=code&state=synthetic', 'set-cookie': 'fam_ru_oauth_state=synthetic; HttpOnly; SameSite=Lax' },
    body: null,
  }) }, async origin => {
    const response = await fetch(new URL('/auth/yandex/start', origin), { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^https:\/\/oauth\.yandex\.ru\/authorize/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  });
  await withServer({}, async origin => {
    const response = await fetch(new URL('/auth/yandex/start', origin));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'auth_not_configured' });
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
    const message = await fetch(new URL('/api/v1/messages', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'synthetic' }) });
    assert.equal(message.status, 200);
    assert.deepEqual(await message.json(), { ok: true, favorited: false });
    const inbox = await fetch(new URL('/api/v1/messages', origin));
    assert.equal(inbox.status, 200);
    assert.deepEqual(await inbox.json(), { ok: true, favorited: false });
  });
  assert.deepEqual(routed, [
    { method: 'PUT', url: `/api/v1/listings/11111111-1111-4111-8111-111111111111/favorite` },
    { method: 'GET', url: '/api/v1/favorites' },
    { method: 'POST', url: '/api/v1/ideas' },
    { method: 'POST', url: '/api/v1/messages' },
    { method: 'GET', url: '/api/v1/messages' },
  ]);
});

test('isolated server routes private image uploads only to the configured media handler', async () => {
  await withServer({ mediaApi: async request => ({ status: 201, body: { ok: true, method: request.method, type: request.headers['content-type'] } }) }, async origin => {
    const response = await fetch(new URL('/api/v1/media/pending', origin), { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'synthetic-image' });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, method: 'POST', type: 'image/png' });
  });
  await withServer({}, async origin => {
    const response = await fetch(new URL('/api/v1/media/pending', origin), { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'synthetic-image' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'media_unavailable' });
  });
});

test('isolated server routes school listing moderation to the backend', async () => {
  await withServer({ listingsApi: async request => ({ status: 200, body: { ok: true, method: request.method } }) }, async origin => {
    const id = '11111111-1111-4111-8111-111111111111';
    const response = await fetch(new URL(`/api/v1/listings/${id}/moderation`, origin), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, method: 'PATCH' });
  });
});

test('isolated server routes the event registration API only to its configured backend', async () => {
  const routed = [];
  const id = '11111111-1111-4111-8111-111111111111';
  await withServer({ listingsApi: async request => {
    routed.push(`${request.method} ${request.url}`);
    return { status: 200, body: { ok: true, method: request.method } };
  } }, async origin => {
    for (const [method, pathname] of [
      ['GET', `/api/v1/listings/${id}/occupancy`],
      ['GET', '/api/v1/event-registrations'],
      ['POST', `/api/v1/listings/${id}/registrations`],
      ['GET', `/api/v1/listings/${id}/registrations`],
      ['DELETE', `/api/v1/listings/${id}/registrations/me`],
      ['PATCH', `/api/v1/listings/${id}/registrations/22222222-2222-4222-8222-222222222222`],
    ]) {
      const response = await fetch(new URL(pathname, origin), { method, headers: { 'content-type': 'application/json' }, body: ['POST', 'PATCH'].includes(method) ? '{}' : undefined });
      assert.equal(response.status, 200, `${method} ${pathname}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), { ok: true, method });
    }
  });
  assert.deepEqual(routed, [
    'GET /api/v1/listings/11111111-1111-4111-8111-111111111111/occupancy',
    'GET /api/v1/event-registrations',
    'POST /api/v1/listings/11111111-1111-4111-8111-111111111111/registrations',
    'GET /api/v1/listings/11111111-1111-4111-8111-111111111111/registrations',
    'DELETE /api/v1/listings/11111111-1111-4111-8111-111111111111/registrations/me',
    'PATCH /api/v1/listings/11111111-1111-4111-8111-111111111111/registrations/22222222-2222-4222-8222-222222222222',
  ]);
  await withServer({}, async origin => {
    const response = await fetch(new URL(`/api/v1/listings/${id}/registrations`, origin), { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
  });
});
