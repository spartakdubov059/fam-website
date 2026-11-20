import { Readable } from 'node:stream';
import { createRequestHandler } from './server.mjs';

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

function eventHeaders(event) {
  const result = Object.create(null);
  for (const [name, values] of Object.entries(event?.multiValueHeaders || {})) {
    if (!HEADER_NAME.test(name) || !Array.isArray(values)) continue;
    const normalized = values.filter(value => typeof value === 'string');
    if (normalized.length) result[name.toLowerCase()] = name.toLowerCase() === 'cookie' ? normalized.join('; ') : normalized.join(', ');
  }
  for (const [name, value] of Object.entries(event?.headers || {})) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || Object.hasOwn(result, name.toLowerCase())) continue;
    result[name.toLowerCase()] = value;
  }
  return result;
}

function eventUrl(event) {
  const supplied = typeof event?.url === 'string' ? event.url : '';
  if (supplied.startsWith('/') && !supplied.startsWith('//')) return supplied;
  const path = typeof event?.path === 'string' && event.path.startsWith('/') ? event.path : '/';
  const query = event?.multiValueQueryStringParameters;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, values] of Object.entries(query)) {
      if (Array.isArray(values)) for (const value of values) if (typeof value === 'string') params.append(key, value);
    }
    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }
  const single = event?.queryStringParameters;
  if (single && typeof single === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(single)) if (typeof value === 'string') params.append(key, value);
    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }
  return path;
}

function eventBody(event) {
  if (event?.body === undefined || event.body === null || event.body === '') return Buffer.alloc(0);
  if (typeof event.body === 'string') {
    if (event.isBase64Encoded === true) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body)) {
        throw new TypeError('invalid base64 request body');
      }
      return Buffer.from(event.body, 'base64');
    }
    return Buffer.from(event.body, 'utf8');
  }
  if (typeof event.body === 'object' && event.isBase64Encoded !== true) return Buffer.from(JSON.stringify(event.body), 'utf8');
  throw new TypeError('invalid request body');
}

function responseHeaders(headers) {
  const single = Object.create(null);
  const multi = Object.create(null);
  for (const [name, raw] of Object.entries(headers || {})) {
    if (!HEADER_NAME.test(name)) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).filter(value => typeof value === 'string' || typeof value === 'number')
      .map(String);
    if (!values.length) continue;
    if (name.toLowerCase() === 'set-cookie') multi[name] = values;
    else single[name] = values.join(', ');
  }
  return { headers: single, ...(Object.keys(multi).length ? { multiValueHeaders: multi } : {}) };
}

function toFunctionResponse(statusCode, headers, body) {
  const normalized = responseHeaders(headers);
  const bytes = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body ?? '');
  const contentType = Object.entries(normalized.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
  const binary = /^(?:image\/|application\/octet-stream|application\/pdf)/i.test(contentType);
  return {
    statusCode,
    ...normalized,
    body: binary ? bytes.toString('base64') : bytes.toString('utf8'),
    isBase64Encoded: binary,
  };
}

export function createYandexFunctionHandler({ requestHandler = createRequestHandler() } = {}) {
  if (typeof requestHandler !== 'function') throw new TypeError('request handler is required');
  return async function handleYandexFunction(event) {
    let body;
    try { body = eventBody(event); } catch {
      return toFunctionResponse(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        JSON.stringify({ ok: false, error: 'invalid_request_body' }));
    }

    const req = Readable.from(body.length ? [body] : []);
    req.method = typeof event?.httpMethod === 'string' ? event.httpMethod.toUpperCase() : 'GET';
    req.url = eventUrl(event);
    req.headers = eventHeaders(event);

    let statusCode = 200;
    let headers = {};
    let responseBody = Buffer.alloc(0);
    let ended = false;
    const res = {
      writeHead(status, nextHeaders = {}) { statusCode = status; headers = nextHeaders; return this; },
      end(value) {
        if (ended) return this;
        ended = true;
        responseBody = value === undefined ? Buffer.alloc(0)
          : Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
        return this;
      },
    };

    try {
      await requestHandler(req, res);
      if (!ended) return toFunctionResponse(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        JSON.stringify({ ok: false, error: 'empty_backend_response' }));
      return toFunctionResponse(statusCode, headers, responseBody);
    } catch {
      return toFunctionResponse(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        JSON.stringify({ ok: false, error: 'backend_request_failed' }));
    }
  };
}

let productionHandler;
async function getProductionHandler() {
  if (!productionHandler) {
    productionHandler = (async () => {
      const { createRuntime } = await import('./runtime.mjs');
      const runtime = await createRuntime();
      return createYandexFunctionHandler({ requestHandler: createRequestHandler({
        listingsApi: runtime?.listingsApi,
        authApi: runtime?.authApi,
        mediaApi: runtime?.mediaApi,
        coderTaskBridge: runtime?.coderTaskBridge,
        getReadiness: runtime?.getReadiness,
      }) });
    })().catch(error => { productionHandler = null; throw error; });
  }
  return productionHandler;
}

export async function handler(event) {
  try { return await (await getProductionHandler())(event); } catch {
    return toFunctionResponse(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      JSON.stringify({ ok: false, error: 'backend_not_ready' }));
  }
}
