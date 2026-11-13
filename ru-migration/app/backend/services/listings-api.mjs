import { submitListing } from './submit-listing.mjs';

export function createListingsApi({ authenticate, resolveActor, repository, review }) {
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const favoriteMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/favorite$/i);
    if (req.method === 'GET' && pathname === '/api/v1/favorites') {
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository.listFavoriteIds !== 'function') return { status: 503, body: { ok: false, error: 'favorite_read_unavailable' } };
      try { return { status: 200, body: { ok: true, favorite_ids: await repository.listFavoriteIds(actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (favoriteMatch && ['PUT', 'DELETE'].includes(req.method)) {
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository.setFavorite !== 'function') return { status: 503, body: { ok: false, error: 'favorite_write_unavailable' } };
      try {
        const favorited = await repository.setFavorite(actor.id, favoriteMatch[1], req.method === 'PUT');
        if (!favorited) return { status: 404, body: { ok: false, error: 'listing_not_found' } };
        return { status: 200, body: { ok: true, listing_id: favoriteMatch[1], favorited: req.method === 'PUT' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me') {
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      return { status: 200, body: { ok: true, profile: actor } };
    }
    if (req.method === 'GET' && pathname === '/api/v1/listings') {
      if (typeof repository.listActiveListings !== 'function') {
        return { status: 503, body: { ok: false, error: 'listing_read_unavailable' } };
      }
      try {
        const listings = await repository.listActiveListings();
        return { status: 200, body: { ok: true, listings } };
      } catch {
        return { status: 503, body: { ok: false, error: 'database_unavailable' } };
      }
    }
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

    let identity;
    try { identity = await authenticate(req); } catch { identity = null; }
    if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    let actor;
    try { actor = await resolveActor(identity); } catch { actor = null; }
    if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
    let input;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } };
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
    const result = await submitListing({ actor, input, repository, review });
    const status = result.ok ? 201 : result.code === 'database_unavailable' ? 503 : result.code === 'forbidden' ? 403 : 400;
    return { status, body: result };
  };
}
