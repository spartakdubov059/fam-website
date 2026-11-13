const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createMediaApi({ authenticate, resolveActor, pendingImages, repository }) {
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const photoMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/photo$/i);
    if (req.method === 'GET' && photoMatch) {
      let listing;
      try { listing = await repository?.getListingPhoto?.(photoMatch[1]); } catch { listing = null; }
      if (!listing?.image_key || !['pending', 'approved'].includes(listing.photo_status)) return { status: 404, body: { ok: false, error: 'photo_unavailable' } };
      if (listing.photo_status === 'pending') {
        let identity; try { identity = await authenticate(req); } catch { identity = null; }
        if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
        let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
        if (!actor || !['school_admin', 'council_member'].includes(actor.role) || actor.school_id !== listing.school_id) {
          return { status: 403, body: { ok: false, error: 'forbidden' } };
        }
      } else if (listing.status !== 'active') {
        let identity; try { identity = await authenticate(req); } catch { identity = null; }
        if (!identity) return { status: 404, body: { ok: false, error: 'photo_unavailable' } };
        let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
        if (!actor || !['school_admin', 'council_member'].includes(actor.role) || actor.school_id !== listing.school_id) {
          return { status: 404, body: { ok: false, error: 'photo_unavailable' } };
        }
      }
      if (typeof pendingImages?.get !== 'function') return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      try { return { status: 200, body: await pendingImages.get(listing.image_key), headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } }; }
      catch { return { status: 404, body: { ok: false, error: 'photo_unavailable' } }; }
    }
    if (req.method === 'PATCH' && photoMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || !['school_admin', 'council_member'].includes(actor.role) || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 4096) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const decision = input?.decision === 'approve' ? 'approved' : input?.decision === 'reject' ? 'rejected' : null;
      if (!decision || typeof repository?.moderateListingPhoto !== 'function') return { status: decision ? 503 : 400, body: { ok: false, error: decision ? 'database_unavailable' : 'invalid_decision' } };
      try {
        const photo = await repository.getListingPhoto(photoMatch[1]);
        if (!photo?.image_key || photo.school_id !== actor.school_id || photo.photo_status !== 'pending' || photo.status !== 'pending') return { status: 404, body: { ok: false, error: 'photo_unavailable' } };
        const changed = await repository.moderateListingPhoto(photoMatch[1], actor.school_id, decision);
        return changed ? { status: 200, body: { ok: true, photo_status: decision } } : { status: 409, body: { ok: false, error: 'photo_review_conflict' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
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
