import { pathToFileURL } from 'node:url';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4178/api/health';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function validateEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new TypeError('invalid local health endpoint'); }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (!['http:', 'https:'].includes(endpoint.protocol) || !LOOPBACK_HOSTS.has(hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== '/api/health'
      || endpoint.search || endpoint.hash) {
    throw new TypeError('health endpoint must target the local readiness route');
  }
  return endpoint;
}

function readinessProjection(value) {
  const services = value?.services;
  return {
    ok: value?.ready === true,
    ready: value?.ready === true,
    services: {
      auth: services?.auth === true,
      database: services?.database === true,
      objectStorage: services?.objectStorage === true,
    },
  };
}

export async function checkRuntimeHealth({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const url = validateEndpoint(endpoint);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new TypeError('invalid health check configuration');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal });
    const body = await response.json();
    const result = readinessProjection(body);
    return response.ok && result.ready ? result : { ...result, ok: false, ready: false };
  } catch {
    return { ok: false, ready: false, code: 'health_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkRuntimeHealth({ endpoint: process.env.FAM_RU_HEALTH_URL || DEFAULT_ENDPOINT });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
