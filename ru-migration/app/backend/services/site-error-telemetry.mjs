export const SITE_ERROR_CODES = Object.freeze([
  'js_runtime', 'unhandled_rejection',
  'listings_load_failed', 'notifications_load_failed',
  'database_request_failed', 'auth_backend_failed',
]);
export const SITE_ERROR_AREAS = Object.freeze(['auth', 'listings', 'notifications', 'database', 'other']);

export function createSiteErrorTelemetry({ repository, now = () => new Date(), maxPerMinute = 60 }) {
  let windowStart = 0;
  let acceptedInWindow = 0;
  return async function report(req) {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    const origin = req.headers?.origin;
    const host = req.headers?.host;
    if (origin) {
      try {
        if (!host || new URL(origin).host.toLowerCase() !== host.toLowerCase()) {
          return { status: 403, body: { ok: false, error: 'origin_not_allowed' } };
        }
      } catch {
        return { status: 403, body: { ok: false, error: 'origin_not_allowed' } };
      }
    }
    let input;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } };
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid_json' } };
    }
    if (!SITE_ERROR_CODES.includes(input?.event_code) || !SITE_ERROR_AREAS.includes(input?.page_area)) {
      return { status: 400, body: { ok: false, error: 'invalid_event' } };
    }
    if (typeof repository?.recordSiteError !== 'function') {
      return { status: 503, body: { ok: false, error: 'telemetry_unavailable' } };
    }
    const timestamp = new Date(now()).getTime();
    if (!Number.isFinite(timestamp)) return { status: 503, body: { ok: false, error: 'telemetry_unavailable' } };
    const minute = Math.floor(timestamp / 60_000);
    if (minute !== windowStart) {
      windowStart = minute;
      acceptedInWindow = 0;
    }
    if (acceptedInWindow >= maxPerMinute) {
      return { status: 429, body: { ok: false, error: 'rate_limited' } };
    }
    acceptedInWindow += 1;
    try {
      await repository.recordSiteError({ eventCode: input.event_code, pageArea: input.page_area, occurredAt: new Date(timestamp) });
      return { status: 202, body: { ok: true } };
    } catch {
      return { status: 503, body: { ok: false, error: 'telemetry_unavailable' } };
    }
  };
}
