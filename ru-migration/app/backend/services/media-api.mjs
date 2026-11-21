const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IDEA_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createMediaApi({ authenticate, resolveActor, pendingImages, repository }) {
  const suspendedModeratorGate = async actor => {
    if (!UUID.test(actor?.id || '') || typeof repository?.getActiveAccountSuspension !== 'function') {
      return { status: 503, body: { ok: false, error: 'suspension_status_unavailable' } };
    }
    try {
      const suspension = await repository.getActiveAccountSuspension(actor.school_id, actor.id);
      return suspension ? { status: 403, body: { ok: false, error: 'account_suspended' } } : null;
    } catch {
      return { status: 503, body: { ok: false, error: 'database_unavailable' } };
    }
  };
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const ideaPhotoMatch = pathname.match(/^\/api\/v1\/ideas\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/images\/([0-2])$/i);
    if (req.method === 'GET' && ideaPhotoMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || !UUID.test(actor.id || '')) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.getSchoolIdeaImage !== 'function' || typeof pendingImages?.get !== 'function') return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      try {
        const image = await repository.getSchoolIdeaImage(ideaPhotoMatch[1], Number(ideaPhotoMatch[2]));
        if (!image || !UUID.test(image.user_id || '') || (typeof image.school_id !== 'string' || !image.school_id)
            || !/^pending\/[0-9a-f-]{36}\/[0-9a-f-]{8}-[0-9a-f-]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i.test(image.image_key)) {
          return { status: 404, body: { ok: false, error: 'idea_image_unavailable' } };
        }
        const owner = actor.id === image.user_id;
        const sameSchool = actor.school_id === image.school_id;
        const schoolModerator = sameSchool && (actor.role === 'school_admin'
          || (actor.role === 'council_member' && image.ai_status === 'approved'));
        if (!owner && !schoolModerator) return { status: 404, body: { ok: false, error: 'idea_image_unavailable' } };
        if (schoolModerator && !owner) {
          const suspensionBlock = await suspendedModeratorGate(actor);
          if (suspensionBlock) return suspensionBlock;
        }
        const bytes = await pendingImages.get(image.image_key);
        return { status: 200, body: bytes, headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } };
      } catch { return { status: 404, body: { ok: false, error: 'idea_image_unavailable' } }; }
    }
    const avatarMatch = pathname.match(/^\/api\/v1\/avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/photo$/i);
    if (req.method === 'GET' && avatarMatch) {
      let review;
      try { review = await repository?.getAvatarReview?.(avatarMatch[1]); } catch { review = null; }
      if (!review || !['pending', 'approved'].includes(review.status) || !UUID.test(review.user_id || '')
          || typeof review.image_key !== 'string'
          || !new RegExp(`^pending/${review.user_id}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i').test(review.image_key)) {
        return { status: 404, body: { ok: false, error: 'avatar_unavailable' } };
      }
      if (review.status === 'pending') {
        let identity; try { identity = await authenticate(req); } catch { identity = null; }
        if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
        let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
        if (!actor || !['school_admin', 'council_member'].includes(actor.role) || actor.school_id !== review.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
        const suspensionBlock = await suspendedModeratorGate(actor);
        if (suspensionBlock) return suspensionBlock;
      } else {
        try {
          if (typeof repository?.isCurrentAvatar !== 'function' || !await repository.isCurrentAvatar(avatarMatch[1])) return { status: 404, body: { ok: false, error: 'avatar_unavailable' } };
        } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      if (typeof pendingImages?.get !== 'function') return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      try { return { status: 200, body: await pendingImages.get(review.image_key), headers: { 'content-type': 'image/webp', 'cache-control': review.status === 'approved' ? 'public, max-age=300' : 'private, no-store', 'x-content-type-options': 'nosniff' } }; }
      catch { return { status: 404, body: { ok: false, error: 'avatar_unavailable' } }; }
    }
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
        const suspensionBlock = await suspendedModeratorGate(actor);
        if (suspensionBlock) return suspensionBlock;
      } else {
        let identity; try { identity = await authenticate(req); } catch { identity = null; }
        if (!identity) return { status: 404, body: { ok: false, error: 'photo_unavailable' } };
        let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
        if (!actor || actor.school_id !== listing.school_id || (listing.status !== 'active'
            && !['school_admin', 'council_member'].includes(actor.role))) {
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
        const suspensionBlock = await suspendedModeratorGate(actor);
        if (suspensionBlock) return suspensionBlock;
        const changed = await repository.moderateListingPhoto(photoMatch[1], actor.school_id, decision);
        return changed ? { status: 200, body: { ok: true, photo_status: decision } } : { status: 409, body: { ok: false, error: 'photo_review_conflict' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    const pendingMatch = pathname.match(/^\/api\/v1\/media\/pending\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (req.method === 'DELETE' && pendingMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || !UUID.test(actor.id)) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof pendingImages?.delete !== 'function' || typeof repository?.claimPendingImageDeletion !== 'function'
          || typeof repository?.finishPendingImageCleanup !== 'function') return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      const key = `pending/${actor.id}/${pendingMatch[1]}.webp`;
      let claimToken = null;
      try {
        claimToken = await repository.claimPendingImageDeletion(actor.id, key);
        if (!claimToken) return { status: 409, body: { ok: false, error: 'photo_already_linked_or_unavailable' } };
        await pendingImages.delete(key);
        if (!await repository.finishPendingImageCleanup(key, claimToken, true)) return { status: 503, body: { ok: false, error: 'media_unavailable' } };
        return { status: 200, body: { ok: true, deleted: true } };
      } catch {
        // A failed object delete can be retried after releasing the short lease.
        try { await repository.finishPendingImageCleanup(key, claimToken, false); } catch { /* lease expiry permits a later retry */ }
        return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      }
    }
    const ideaImageUpload = pathname === '/api/v1/ideas/media/pending';
    const avatarImageUpload = pathname === '/api/v1/avatars/media/pending';
    if (req.method !== 'POST' || (!ideaImageUpload && !avatarImageUpload && pathname !== '/api/v1/media/pending')) {
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
    const imageByteLimit = ideaImageUpload || avatarImageUpload ? MAX_IDEA_IMAGE_BYTES : MAX_IMAGE_BYTES;
    const statedLength = Number(req.headers?.['content-length'] || 0);
    if (Number.isFinite(statedLength) && statedLength > imageByteLimit) {
      return { status: 413, body: { ok: false, error: 'image_too_large' } };
    }

    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > imageByteLimit) return { status: 413, body: { ok: false, error: 'image_too_large' } };
        chunks.push(chunk);
      }
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid_image' } };
    }
    if (bytes === 0) return { status: 400, body: { ok: false, error: 'empty_image' } };
    if (typeof repository?.registerPendingImage !== 'function' || typeof repository?.reserveImageUpload !== 'function') {
      return { status: 503, body: { ok: false, error: 'media_unavailable' } };
    }

    try {
      // Reserve before Sharp decodes the supplied bytes so repeated invalid files are bounded too.
      if (!await repository.reserveImageUpload(actor.id)) return { status: 429, body: { ok: false, error: 'rate_limited' } };
      const result = await pendingImages.put({ userId: actor.id, bytes: Buffer.concat(chunks), contentType, maxBytes: imageByteLimit });
      const keyPattern = new RegExp(`^pending/${actor.id}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i');
      if (!result || typeof result.key !== 'string' || !keyPattern.test(result.key)
          || result.contentType !== 'image/webp' || !Number.isInteger(result.bytes) || result.bytes < 1) {
        if (result?.key && typeof pendingImages.delete === 'function' && keyPattern.test(result.key)) {
          try { await pendingImages.delete(result.key); } catch { /* account inventory can remove an unregistered object later */ }
        }
        return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      }
      if (result.bytes > imageByteLimit) {
        try { await pendingImages.delete(result.key); }
        catch { try { await repository.registerPendingImage(actor.id, result.key); } catch { /* account inventory can remove an unregistered object later */ } }
        return { status: 413, body: { ok: false, error: 'image_too_large' } };
      }
      try {
        await repository.registerPendingImage(actor.id, result.key);
      } catch {
        try { await pendingImages.delete(result.key); } catch { /* no key is returned to the caller; cleanup can retry manually */ }
        return { status: 503, body: { ok: false, error: 'media_unavailable' } };
      }
      return { status: 201, body: { ok: true, image: { key: result.key, content_type: result.contentType, bytes: result.bytes } } };
    } catch (error) {
      if (error?.code === 'rate_limited') return { status: 429, body: { ok: false, error: 'rate_limited' } };
      if (error?.code === 'image_too_large') return { status: 413, body: { ok: false, error: 'image_too_large' } };
      if (error instanceof TypeError) return { status: 400, body: { ok: false, error: 'invalid_image' } };
      return { status: 503, body: { ok: false, error: 'media_unavailable' } };
    }
  };
}
