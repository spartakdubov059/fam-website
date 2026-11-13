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
