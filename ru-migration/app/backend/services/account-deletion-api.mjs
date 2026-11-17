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
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const reviewMatch = pathname.match(new RegExp(`^/api/v1/deletion-requests/(${UUID_SOURCE})$`, 'i'));
    const selfDeletion = req.method === 'DELETE' && pathname === '/api/v1/me/account';
    const adminDeleteMatch = pathname.match(new RegExp(`^/api/v1/school/accounts/(${UUID_SOURCE})$`, 'i'));
    const adminDeletion = req.method === 'DELETE' && adminDeleteMatch;
    if (!selfDeletion && !adminDeletion && !(req.method === 'PATCH' && reviewMatch)) {
      return { status: 404, body: { ok: false, error: 'not_found' } };
    }
    let identity;
    try { identity = await authenticate(req); } catch { identity = null; }
    if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    let actor;
    try { actor = await resolveActor(identity); } catch { actor = null; }
    if (!actor?.id || !actor.school_id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
    const parsed = await readJson(req);
    if (parsed.error) return { status: parsed.error === 'request_too_large' ? 413 : 400, body: { ok: false, error: parsed.error } };
    if (adminDeletion) {
      if (actor.role !== 'school_admin') return { status: 403, body: { ok: false, error: 'forbidden' } };
      const currentSeconds = Math.floor(now() / 1000);
      if (!Number.isInteger(identity.authenticated_at) || identity.authenticated_at > currentSeconds + 5
          || identity.authenticated_at < currentSeconds - 600) {
        return { status: 403, body: { ok: false, error: 'recent_yandex_login_required' } };
      }
      if (adminDeleteMatch[1].toLowerCase() === actor.id.toLowerCase()) return { status: 403, body: { ok: false, error: 'cannot_delete_self' } };
      if (parsed.value.confirmation !== 'УДАЛИТЬ АККАУНТ УЧАСТНИКА') return { status: 400, body: { ok: false, error: 'confirmation_required' } };
    } else if (!selfDeletion) {
      if (actor.role !== 'school_admin') return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (parsed.value.decision === 'reject') {
        const note = typeof parsed.value.review_note === 'string' ? parsed.value.review_note.trim().slice(0, 240) : '';
        if (typeof repository?.rejectAccountDeletionRequest !== 'function') return { status: 503, body: { ok: false, error: 'deletion_requests_unavailable' } };
        try {
          const rejected = await repository.rejectAccountDeletionRequest(reviewMatch[1], actor.school_id, actor.id, note);
          return rejected ? { status: 200, body: { ok: true, status: 'rejected' } }
            : { status: 409, body: { ok: false, error: 'request_unavailable' } };
        } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      const currentSeconds = Math.floor(now() / 1000);
      if (!Number.isInteger(identity.authenticated_at) || identity.authenticated_at > currentSeconds + 5
          || identity.authenticated_at < currentSeconds - 600) {
        return { status: 403, body: { ok: false, error: 'recent_yandex_login_required' } };
      }
      if (parsed.value.decision !== 'approve' || parsed.value.confirmation !== 'УДАЛИТЬ АККАУНТ УЧАСТНИКА') {
        return { status: 400, body: { ok: false, error: 'confirmation_required' } };
      }
    } else {
      const currentSeconds = Math.floor(now() / 1000);
      if (!Number.isInteger(identity.authenticated_at) || identity.authenticated_at > currentSeconds + 5
          || identity.authenticated_at < currentSeconds - 600) {
        return { status: 403, body: { ok: false, error: 'recent_yandex_login_required' } };
      }
      if (parsed.value.confirmation !== CONFIRMATION) return { status: 400, body: { ok: false, error: 'confirmation_required' } };
    }
    if ((selfDeletion && typeof repository?.beginAccountDeletion !== 'function')
        || (adminDeletion && typeof repository?.beginAdminAccountDeletion !== 'function')
        || (!selfDeletion && !adminDeletion && typeof repository?.beginRequestedAccountDeletion !== 'function')
        || typeof repository?.finishAccountDeletion !== 'function'
        || ((selfDeletion || adminDeletion) && typeof repository?.restoreAccountAfterDeletionFailure !== 'function')
        || (!selfDeletion && !adminDeletion && typeof repository?.restoreRequestedAccountDeletion !== 'function')) {
      return { status: 503, body: { ok: false, error: 'account_deletion_unavailable' } };
    }
    if (typeof pendingImages?.listUserObjects !== 'function' || typeof pendingImages?.delete !== 'function') {
      return { status: 503, body: { ok: false, error: 'private_storage_unavailable' } };
    }

    let deactivated = false;
    let target;
    try {
      const begun = selfDeletion
        ? await repository.beginAccountDeletion({ issuer: identity.issuer, subject: identity.subject, userId: actor.id })
        : adminDeletion
          ? await repository.beginAdminAccountDeletion({ schoolId: actor.school_id, reviewerId: actor.id, targetId: adminDeleteMatch[1] })
          : await repository.beginRequestedAccountDeletion({ requestId: reviewMatch[1], schoolId: actor.school_id, reviewerId: actor.id });
      if (!begun?.ok) {
        const code = begun?.code || 'profile_unavailable';
        const status = code === 'last_school_admin' ? 409 : code === 'target_unavailable' ? 404 : 403;
        return { status, body: { ok: false, error: code } };
      }
      deactivated = true;
      target = selfDeletion ? { id: actor.id, issuer: identity.issuer, subject: identity.subject, school_id: actor.school_id }
        : adminDeletion ? { ...begun, reviewer_id: actor.id, direct_admin_deletion: true }
          : { ...begun, request_id: reviewMatch[1], reviewer_id: actor.id };
      if (!target.id || !USER_ID.test(target.id) || !target.issuer || !target.subject) throw new Error('invalid deletion target');
      const keys = await pendingImages.listUserObjects(target.id);
      if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !IMAGE_KEY.test(key)
          || key.split('/')[1].toLowerCase() !== target.id.toLowerCase())) throw new Error('invalid_storage_inventory');
      for (const key of new Set(keys)) await pendingImages.delete(key);
      const deleted = await repository.finishAccountDeletion({
        issuer: target.issuer, subject: target.subject, userId: target.id, schoolId: target.school_id,
        preserveRequestId: target.request_id, reviewerId: target.reviewer_id,
        adminAudit: target.direct_admin_deletion ? { actorId: actor.id, schoolId: actor.school_id, targetRole: target.role } : null,
        reviewNote: typeof parsed.value.review_note === 'string' ? parsed.value.review_note.trim().slice(0, 240) : '',
      });
      if (!deleted?.ok) throw new Error('database_deletion_failed');
      return { status: 200, body: { ok: true, deleted: true, removed_images: new Set(keys).size } };
    } catch {
      if (deactivated) {
        try {
          if (selfDeletion) await repository.restoreAccountAfterDeletionFailure({ issuer: identity.issuer, subject: identity.subject, userId: actor.id });
          else if (adminDeletion) await repository.restoreAccountAfterDeletionFailure({ issuer: target?.issuer, subject: target?.subject, userId: target?.id });
          else await repository.restoreRequestedAccountDeletion({ requestId: reviewMatch[1], schoolId: actor.school_id, reviewerId: actor.id, targetId: target?.id });
        }
        catch { /* failed cleanup remains inactive until an operator repairs the isolated staging database */ }
      }
      return { status: 503, body: { ok: false, error: 'account_deletion_failed' } };
    }
  };
}
