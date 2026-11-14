const CONFIRMATION = 'УДАЛИТЬ МОЙ АККАУНТ';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const USER_ID = new RegExp(`^${UUID_SOURCE}$`, 'i');
const IMAGE_KEY = new RegExp(`^pending/${UUID_SOURCE}/${UUID_SOURCE}\\.webp$`, 'i');

async function readJson(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024) return { error: 'request_too_large' };
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'invalid_json' };
  } catch { return { error: 'invalid_json' }; }
}

export function createAccountDeletionApi({ authenticate = async () => null, resolveActor = async () => null,
  repository, pendingImages, now = Date.now } = {}) {
  return async function handle(req) {
    if (req.method !== 'DELETE' || new URL(req.url || '/', 'http://localhost').pathname !== '/api/v1/me/account') {
      return { status: 404, body: { ok: false, error: 'not_found' } };
    }
    let identity;
    try { identity = await authenticate(req); } catch { identity = null; }
    if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    const currentSeconds = Math.floor(now() / 1000);
    if (!Number.isInteger(identity.authenticated_at) || identity.authenticated_at > currentSeconds + 5
        || identity.authenticated_at < currentSeconds - 600) {
      return { status: 403, body: { ok: false, error: 'recent_yandex_login_required' } };
    }
    let actor;
    try { actor = await resolveActor(identity); } catch { actor = null; }
    if (!actor?.id || !actor.school_id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
    const parsed = await readJson(req);
    if (parsed.error) return { status: parsed.error === 'request_too_large' ? 413 : 400, body: { ok: false, error: parsed.error } };
    if (parsed.value.confirmation !== CONFIRMATION) return { status: 400, body: { ok: false, error: 'confirmation_required' } };
    if (typeof repository?.beginAccountDeletion !== 'function' || typeof repository?.finishAccountDeletion !== 'function'
        || typeof repository?.restoreAccountAfterDeletionFailure !== 'function') {
      return { status: 503, body: { ok: false, error: 'account_deletion_unavailable' } };
    }
    if (!USER_ID.test(actor.id) || typeof pendingImages?.listUserObjects !== 'function' || typeof pendingImages?.delete !== 'function') {
      return { status: 503, body: { ok: false, error: 'private_storage_unavailable' } };
    }

    let deactivated = false;
    try {
      const begun = await repository.beginAccountDeletion({ issuer: identity.issuer, subject: identity.subject, userId: actor.id });
      if (!begun?.ok) {
        const code = begun?.code || 'profile_unavailable';
        return { status: code === 'last_school_admin' ? 409 : 403, body: { ok: false, error: code } };
      }
      deactivated = true;
      const keys = await pendingImages.listUserObjects(actor.id);
      if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !IMAGE_KEY.test(key)
          || key.split('/')[1].toLowerCase() !== actor.id.toLowerCase())) throw new Error('invalid_storage_inventory');
      for (const key of new Set(keys)) await pendingImages.delete(key);
      const deleted = await repository.finishAccountDeletion({
        issuer: identity.issuer, subject: identity.subject, userId: actor.id, schoolId: actor.school_id,
      });
      if (!deleted?.ok) throw new Error('database_deletion_failed');
      return { status: 200, body: { ok: true, deleted: true, removed_images: new Set(keys).size } };
    } catch {
      if (deactivated) {
        try { await repository.restoreAccountAfterDeletionFailure({ issuer: identity.issuer, subject: identity.subject, userId: actor.id }); }
        catch { /* failed cleanup remains inactive until an operator repairs the isolated staging database */ }
      }
      return { status: 503, body: { ok: false, error: 'account_deletion_failed' } };
    }
  };
}
