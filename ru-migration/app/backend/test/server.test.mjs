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
    assert.match(html, /ruListingForm/);
    assert.match(html, /id="ruOpenMessages"/);
    assert.match(html, /id="ruMessages"/);
    assert.match(html, /messagesScript\.src = '\/messages\.js'/);
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

    const listingSubmit = await fetch(new URL('/listing-submit.js', origin));
    assert.equal(listingSubmit.status, 200);
    assert.match(listingSubmit.headers.get('content-type'), /javascript/);
    assert.match(await listingSubmit.text(), /api\/v1\/media\/pending/);

    const messages = await fetch(new URL('/messages.js', origin));
    assert.equal(messages.status, 200);
    assert.match(messages.headers.get('content-type'), /javascript/);
    assert.match(await messages.text(), /api\/v1\/messages/);

    const pulse = await fetch(new URL('/pulse.js', origin));
    assert.equal(pulse.status, 200);
    assert.match(await pulse.text(), /api\/v1\/pulse/);
    assert.match(html, /id="ruPulse"/);
    assert.match(html, /pulseScript\.src = '\/pulse\.js'/);
    assert.match(html, /href="\/auth\/yandex\/start\?reauth=1"/);
    assert.match(html, /fetch\("\/api\/v1\/me\/account"/);
    assert.doesNotMatch(html, /selfDeletePassword/);

    const moderation = await fetch(new URL('/listing-moderation.js', origin));
    assert.equal(moderation.status, 200);
    assert.match(moderation.headers.get('content-type'), /javascript/);
    assert.match(await moderation.text(), /api\/v1\/listings\/moderation/);

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

    const pulse = await fetch(new URL('/api/v1/pulse', origin));
    assert.equal(pulse.status, 503);
    assert.equal((await pulse.json()).error, 'backend_not_configured');
  });
});

test('self account deletion routes through the configured Russian backend', async () => {
  let method;
  await withServer({ listingsApi: async req => {
    method = req.method;
    return { status: 200, body: { ok: true, deleted: true } };
  } }, async origin => {
    const response = await fetch(new URL('/api/v1/me/account', origin), {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'synthetic' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deleted: true });
    assert.equal(method, 'DELETE');
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
    const profileStatus = await fetch(new URL('/api/v1/profile-requests', origin));
    assert.equal(profileStatus.status, 200);
    assert.deepEqual(await profileStatus.json(), { ok: true, favorited: false });
  });
  assert.deepEqual(routed, [
    { method: 'PUT', url: `/api/v1/listings/11111111-1111-4111-8111-111111111111/favorite` },
    { method: 'GET', url: '/api/v1/favorites' },
    { method: 'POST', url: '/api/v1/ideas' },
    { method: 'POST', url: '/api/v1/messages' },
    { method: 'GET', url: '/api/v1/messages' },
    { method: 'GET', url: '/api/v1/profile-requests' },
  ]);
});

test('isolated server routes school suspension status to listings API', async () => {
  let routed = false;
  await withServer({ listingsApi: async request => {
    if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/api/v1/suspensions') routed = true;
    return { status: 200, body: { ok: true, suspensions: [] } };
  } }, async origin => {
    const response = await fetch(new URL('/api/v1/suspensions', origin));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, suspensions: [] });
  });
  assert.equal(routed, true);
});

test('isolated server routes personal suspension status to the authenticated listings API', async () => {
  await withServer({ listingsApi: async request => ({ status: 200, body: {
    ok: true, route: new URL(request.url, 'http://localhost').pathname,
  } }) }, async origin => {
    const response = await fetch(new URL('/api/v1/me/suspension', origin));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, route: '/api/v1/me/suspension' });
  });
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

test('isolated server sends photo bytes with verified image headers instead of JSON serialization', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await withServer({ mediaApi: async () => ({ status: 200, body: Buffer.from([0x52, 0x49, 0x46, 0x46]),
    headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store' } }) }, async origin => {
    const response = await fetch(new URL(`/api/v1/listings/${id}/photo`, origin));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x52, 0x49, 0x46, 0x46]);
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

test('isolated server routes listing contact messages to the configured backend', async () => {
  let received;
  await withServer({ listingsApi: async request => { received = { method: request.method, url: request.url, body: await new Promise(resolve => {
    let value = ''; request.setEncoding('utf8'); request.on('data', chunk => { value += chunk; }); request.on('end', () => resolve(value));
  }) }; return { status: 201, body: { ok: true } }; } }, async origin => {
    const response = await fetch(new URL('/api/v1/listings/11111111-1111-4111-8111-111111111111/contact', origin), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello' }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(received, { method: 'POST', url: '/api/v1/listings/11111111-1111-4111-8111-111111111111/contact', body: '{"body":"hello"}' });
  });
});

test('isolated server routes the private moderation queue to the listings API', async () => {
  await withServer({ listingsApi: async request => ({ status: 200, body: { ok: true, route: request.url } }) }, async origin => {
    const response = await fetch(new URL('/api/v1/listings/moderation', origin));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, route: '/api/v1/listings/moderation' });
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

test('isolated server routes school catalog and access-request lifecycle to the configured backend', async () => {
  const routed = [];
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await withServer({ listingsApi: async request => {
    routed.push(`${request.method} ${request.url}`);
    return { status: 200, body: { ok: true, route: request.url } };
  } }, async origin => {
    for (const [method, pathname] of [
      ['GET', '/api/v1/schools'],
      ['PATCH', '/api/v1/me'],
      ['POST', '/api/v1/profile-requests'],
      ['GET', '/api/v1/profile-requests/review'],
      ['PATCH', `/api/v1/profile-requests/${id}`],
      ['POST', '/api/v1/role-requests'],
      ['GET', '/api/v1/role-requests'],
      ['GET', '/api/v1/role-requests/review'],
      ['PATCH', `/api/v1/role-requests/${id}`],
      ['GET', '/api/v1/deletion-requests/targets'],
      ['GET', '/api/v1/deletion-requests'],
      ['GET', '/api/v1/deletion-requests/review'],
      ['POST', '/api/v1/deletion-requests'],
      ['PATCH', `/api/v1/deletion-requests/${id}`],
    ]) {
      const response = await fetch(new URL(pathname, origin), { method, headers: { 'content-type': 'application/json' }, body: ['POST', 'PATCH'].includes(method) ? '{}' : undefined });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, route: pathname });
    }
  });
  assert.deepEqual(routed, [
    'GET /api/v1/schools', 'PATCH /api/v1/me', 'POST /api/v1/profile-requests', 'GET /api/v1/profile-requests/review', `PATCH /api/v1/profile-requests/${id}`,
    'POST /api/v1/role-requests', 'GET /api/v1/role-requests', 'GET /api/v1/role-requests/review', `PATCH /api/v1/role-requests/${id}`,
    'GET /api/v1/deletion-requests/targets', 'GET /api/v1/deletion-requests', 'GET /api/v1/deletion-requests/review', 'POST /api/v1/deletion-requests', `PATCH /api/v1/deletion-requests/${id}`,
  ]);
});
