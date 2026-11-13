export function createSuspensionWriteGuard({ authenticate, resolveActor, repository }) {
  if (typeof authenticate !== 'function' || typeof resolveActor !== 'function') {
    throw new TypeError('authentication and actor resolution are required');
  }
  return function guard(handler) {
    if (typeof handler !== 'function') throw new TypeError('request handler is required');
    return async function guardedHandler(req) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return handler(req);
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return handler(req);
      let actor;
      try { actor = await resolveActor(identity); }
      catch { return { status: 503, body: { ok: false, error: 'account_status_unavailable' } }; }
      if (!actor) return handler(req);
      if (typeof repository?.getActiveAccountSuspension !== 'function') {
        return { status: 503, body: { ok: false, error: 'account_status_unavailable' } };
      }
      let suspension;
      try { suspension = await repository.getActiveAccountSuspension(actor.school_id, actor.id); }
      catch { return { status: 503, body: { ok: false, error: 'account_status_unavailable' } }; }
      if (suspension) {
        return { status: 403, body: {
          ok: false, error: 'account_suspended', suspended: true,
          suspended_until: suspension.expires_at,
          message: `Запись временно ограничена. Срок: ${suspension.expires_at}. Причина: ${String(suspension.reason || '').slice(0, 240)}`,
        } };
      }
      return handler(req);
    };
  };
}
