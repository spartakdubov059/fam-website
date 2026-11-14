import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../web');
const host = process.env.FAM_RU_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.FAM_RU_PORT || '4178', 10);
const maxBodyBytes = 256 * 1024;
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.ico', 'image/x-icon'],
]);

function readiness() {
  return {
    mode: 'isolated-copy',
    ready: false,
    services: {
      auth: Boolean((process.env.FAM_RU_YANDEX_CLIENT_ID && process.env.FAM_RU_YANDEX_REDIRECT_URI && process.env.FAM_RU_SESSION_SECRET)
        || (process.env.FAM_RU_AUTH_ISSUER && process.env.FAM_RU_AUTH_AUDIENCE)),
      database: Boolean(process.env.FAM_RU_DATABASE_URL),
      objectStorage: Boolean(process.env.FAM_RU_S3_ENDPOINT && process.env.FAM_RU_S3_BUCKET),
    },
    message: 'Russian backend adapters are not configured; user data operations remain disabled.',
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendMediaResult(res, result) {
  if (Buffer.isBuffer(result.body) || result.body instanceof Uint8Array) {
    const body = Buffer.from(result.body);
    res.writeHead(result.status, { ...result.headers, 'content-length': body.length, 'x-content-type-options': 'nosniff' });
    return res.end(body);
  }
  return sendJson(res, result.status, result.body);
}

export function createServer({ listingsApi = null, authApi = null, mediaApi = null } = {}) {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (['/auth/yandex/start', '/auth/yandex/callback', '/auth/yandex/logout'].includes(url.pathname)) {
    if (!authApi) return sendJson(res, 503, { ok: false, error: 'auth_not_configured' });
    try {
      const result = await authApi(req);
      if (result.body === null) {
        res.writeHead(result.status, result.headers || {});
        return res.end();
      }
      return sendJson(res, result.status, result.body);
    } catch {
      return sendJson(res, 503, { ok: false, error: 'auth_request_failed' });
    }
  }
  if (req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/api/v1/status')) {
    const state = readiness();
    return sendJson(res, state.ready ? 200 : 503, state);
  }
  if ((req.method === 'POST' && url.pathname === '/api/v1/media/pending')
      || (req.method === 'DELETE' && /^\/api\/v1\/media\/pending\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname))
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/photo$/i.test(url.pathname) && ['GET', 'PATCH'].includes(req.method))) {
    if (!mediaApi) return sendJson(res, 503, { ok: false, error: 'media_unavailable' });
    try {
      const result = await mediaApi(req);
      return sendMediaResult(res, result);
    } catch {
      return sendJson(res, 503, { ok: false, error: 'media_unavailable' });
    }
  }
  if ((((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/v1/listings')
      || (req.method === 'POST' && url.pathname === '/api/v1/ideas')
      || (req.method === 'POST' && url.pathname === '/api/v1/messages')
      || (req.method === 'POST' && /^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/contact$/i.test(url.pathname))
      || (req.method === 'GET' && ['/api/v1/me', '/api/v1/favorites', '/api/v1/messages'].includes(url.pathname))
      || (req.method === 'GET' && url.pathname === '/api/v1/me/listings')
      || (req.method === 'GET' && url.pathname === '/api/v1/event-registrations')
      || (req.method === 'GET' && url.pathname === '/api/v1/event-registrations/review')
      || (req.method === 'GET' && url.pathname === '/api/v1/schools')
      || (req.method === 'POST' && url.pathname === '/api/v1/profile-requests')
      || (req.method === 'GET' && url.pathname === '/api/v1/profile-requests')
      || (req.method === 'GET' && url.pathname === '/api/v1/profile-requests/review')
      || (req.method === 'GET' && url.pathname === '/api/v1/suspensions')
      || (req.method === 'GET' && url.pathname === '/api/v1/me/suspension')
      || (req.method === 'GET' && ['/api/v1/deletion-requests', '/api/v1/deletion-requests/targets', '/api/v1/deletion-requests/review'].includes(url.pathname))
      || (req.method === 'POST' && url.pathname === '/api/v1/deletion-requests')
      || (req.method === 'PATCH' && /^\/api\/v1\/deletion-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname))
      || (/^\/api\/v1\/profile-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname) && req.method === 'PATCH')
      || (req.method === 'POST' && url.pathname === '/api/v1/role-requests')
      || (req.method === 'GET' && ['/api/v1/role-requests', '/api/v1/role-requests/review'].includes(url.pathname))
      || (/^\/api\/v1\/role-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname) && req.method === 'PATCH')
      || (req.method === 'GET' && url.pathname === '/api/v1/listings/moderation')
      || (req.method === 'GET' && url.pathname.startsWith('/api/v1/listings/') && url.pathname.endsWith('/registrations'))
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/occupancy$/i.test(url.pathname) && req.method === 'GET')
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/registrations$/i.test(url.pathname) && req.method === 'POST')
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}\/registrations$/i.test(url.pathname) && req.method === 'GET')
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/registrations\/me$/i.test(url.pathname) && req.method === 'DELETE')
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/registrations\/[0-9a-f-]{36}$/i.test(url.pathname) && req.method === 'PATCH')
      || (req.method === 'PATCH' && /^\/api\/v1\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/read$/i.test(url.pathname))
      || (req.method === 'PATCH' && url.pathname === '/api/v1/me')
      || (req.method === 'DELETE' && /^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname))
      || (req.method === 'PATCH' && /^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/moderation$/i.test(url.pathname))
      || (/^\/api\/v1\/listings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/favorite$/i.test(url.pathname) && ['PUT', 'DELETE'].includes(req.method)))) {
    if (!listingsApi) return sendJson(res, 503, { ok: false, error: 'backend_not_configured' });
    try {
      const result = await listingsApi(req);
      return sendJson(res, result.status, result.body);
    } catch {
      return sendJson(res, 503, { ok: false, error: 'request_failed' });
    }
  }
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) return sendJson(res, 413, { error: 'request_too_large' });
      }
    }
    return sendJson(res, 503, { error: 'backend_not_configured', message: 'This isolated copy is not connected to any user database.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'invalid_path' }); }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(webRoot, relative);
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) return sendJson(res, 404, { error: 'not_found' });
  try {
    const info = await stat(target);
    if (!info.isFile()) return sendJson(res, 404, { error: 'not_found' });
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': mime.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': path.extname(target) === '.html' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    return sendJson(res, 404, { error: 'not_found' });
  }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await (await import('./runtime.mjs')).createRuntime();
  createServer({ listingsApi: runtime?.listingsApi, authApi: runtime?.authApi, mediaApi: runtime?.mediaApi }).listen(port, host, () => {
    console.log(`FAM RU isolated copy listening on http://${host}:${port}`);
  });
  if (runtime) {
    const shutdown = async () => { await runtime.close(); process.exit(0); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
