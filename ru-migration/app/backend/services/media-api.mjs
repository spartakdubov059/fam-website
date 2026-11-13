const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createMediaApi({ authenticate, resolveActor, pendingImages }) {
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method !== 'POST' || pathname !== '/api/v1/media/pending') {
      return { status: 404, body: { ok: false, error: 'not_found' } };
    }
    if (!pendingImages || typeof pendingImages.put !== 'function') {
      return { status: 503, body: { ok: false, error: 'media_unavailable' } };
    }
    let identity; try { identity = await authenticate(req); } catch { identity = null; }
    if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
    if (!actor || typeof actor.id !== 'string' || !UUID.test(actor.id)) {
      return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
    }

    const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) return { status: 415, body: { ok: false, error: 'unsupported_image_type' } };
    const statedLength = Number(req.headers?.['content-length'] || 0);
    if (Number.isFinite(statedLength) && statedLength > MAX_IMAGE_BYTES) {
      return { status: 413, body: { ok: false, error: 'image_too_large' } };
    }

    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) return { status: 413, body: { ok: false, error: 'image_too_large' } };
        chunks.push(chunk);
      }
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid_image' } };
    }
    if (bytes === 0) return { status: 400, body: { ok: false, error: 'empty_image' } };

    try {
      const result = await pendingImages.put({ userId: actor.id, bytes: Buffer.concat(chunks), contentType });
      const keyPattern = new RegExp(`^pending/${actor.id}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i');
      if (!result || typeof result.key !== 'string' || !keyPattern.test(result.key)
          || result.contentType !== 'image/webp' || !Number.isInteger(result.bytes) || result.bytes < 1 || result.bytes > MAX_IMAGE_BYTES) {
        return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      }
      return { status: 201, body: { ok: true, image: { key: result.key, content_type: result.contentType, bytes: result.bytes } } };
    } catch (error) {
      if (error instanceof TypeError) return { status: 400, body: { ok: false, error: 'invalid_image' } };
      return { status: 503, body: { ok: false, error: 'media_unavailable' } };
    }
  };
}
