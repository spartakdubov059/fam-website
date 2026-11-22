const DEFAULT_ENDPOINT = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';

export function createYandexIamMetadataTokenProvider({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch,
  now = Date.now, refreshSkewMs = 60_000 } = {}) {
  let cachedToken = null;
  let refreshAt = 0;
  let inFlight = null;
  if (endpoint !== DEFAULT_ENDPOINT
      || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !Number.isSafeInteger(refreshSkewMs) || refreshSkewMs < 0 || refreshSkewMs > 300_000) {
    throw new TypeError('invalid Yandex metadata token provider configuration');
  }

  return async function getYandexIamMetadataToken() {
    if (cachedToken && now() < refreshAt) return cachedToken;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await fetchImpl(endpoint, {
        headers: { 'metadata-flavor': 'Google' },
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error('Yandex metadata service rejected IAM token request');
      const body = await response.json();
      if (typeof body?.access_token !== 'string' || body.access_token.length < 20 || body.access_token.length > 4096
          || !Number.isSafeInteger(body.expires_in) || body.expires_in < 60 || body.expires_in > 43_200) {
        throw new Error('Yandex metadata service returned an invalid IAM token');
      }
      cachedToken = body.access_token;
      refreshAt = now() + Math.max(0, body.expires_in * 1000 - refreshSkewMs);
      return cachedToken;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };
}
