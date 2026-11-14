import { submitListing } from './submit-listing.mjs';
import { submitIdea } from './submit-idea.mjs';
import { submitMessage } from './submit-message.mjs';
import { requestSchoolProfile } from './request-school-profile.mjs';
import { SCHOOL_CATALOG } from '../policies/school-catalog.mjs';

export function createListingsApi({ authenticate, resolveActor, repository, review, schools = SCHOOL_CATALOG, pendingImages = null, now = Date.now }) {
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const readMessageMatch = pathname.match(/^\/api\/v1\/messages\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/read$/i);
    const listingContactMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/contact$/i);
    const ownListingMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const moderationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/moderation$/i);
    const eventOccupancyMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/occupancy$/i);
    const eventRegistrationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations$/i);
    const eventReviewMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const eventCancellationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations\/me$/i);
    const profileRequestMatch = pathname.match(/^\/api\/v1\/profile-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const roleRequestMatch = pathname.match(/^\/api\/v1\/role-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (req.method === 'GET' && pathname === '/api/v1/schools') {
      return { status: 200, body: { ok: true, schools: schools.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string').map(({ id, name }) => ({ id, name })) } };
    }
    if (req.method === 'GET' && pathname === '/api/v1/profile-requests') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      if (typeof repository?.getSchoolProfileRequest !== 'function') return { status: 503, body: { ok: false, error: 'profile_request_status_unavailable' } };
      try {
        const request = await repository.getSchoolProfileRequest(identity.issuer, identity.subject);
        return { status: 200, body: { ok: true, request } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/role-requests') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      if (typeof repository?.getSchoolRoleRequest !== 'function') return { status: 503, body: { ok: false, error: 'role_request_unavailable' } };
      try { return { status: 200, body: { ok: true, request: await repository.getSchoolRoleRequest(identity.issuer, identity.subject) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'POST' && pathname === '/api/v1/role-requests') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let input;
      try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || actor.role !== 'student' || !actor.school_id) return { status: 403, body: { ok: false, error: 'student_profile_required' } };
      const requested_role = input?.requested_role === 'Участник Ученического совета' ? 'council_member'
        : input?.requested_role === 'Администратор' ? 'school_admin' : null;
      if (!requested_role) return { status: 400, body: { ok: false, error: 'invalid_requested_role' } };
      if (typeof repository?.createSchoolRoleRequest !== 'function') return { status: 503, body: { ok: false, error: 'role_request_unavailable' } };
      try {
        const result = await repository.createSchoolRoleRequest({ issuer: identity.issuer, subject: identity.subject, requested_role });
        return result?.ok ? { status: result.already_exists ? 200 : 202, body: result }
          : { status: result?.code === 'student_profile_required' ? 403 : 503, body: { ok: false, error: result?.code || 'database_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/role-requests/review') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listPendingSchoolRoleRequests !== 'function') return { status: 503, body: { ok: false, error: 'role_review_unavailable' } };
      try { return { status: 200, body: { ok: true, requests: await repository.listPendingSchoolRoleRequests(actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/suspensions') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listActiveAccountSuspensions !== 'function') return { status: 503, body: { ok: false, error: 'suspensions_unavailable' } };
      try { return { status: 200, body: { ok: true, suspensions: await repository.listActiveAccountSuspensions(actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/suspensions/targets') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listSuspensionTargets !== 'function') return { status: 503, body: { ok: false, error: 'suspensions_unavailable' } };
      try { return { status: 200, body: { ok: true, targets: await repository.listSuspensionTargets(actor.school_id, actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    const suspensionAction = pathname.match(/^\/api\/v1\/suspensions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (req.method === 'PATCH' && suspensionAction) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      const authenticatedAt = Number(identity.authenticated_at);
      const ageSeconds = now() / 1000 - authenticatedAt;
      if (!Number.isFinite(authenticatedAt) || ageSeconds < 0 || ageSeconds > 600) {
        return { status: 403, body: { ok: false, error: 'fresh_auth_required' } };
      }
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id || !actor.id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (input?.action === 'issue') {
        const durationHours = Number(input.duration_hours);
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        const digits = (reason.match(/[0-9]/g) || []).length;
        const hasContact = /https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(reason) || digits >= 11;
        if (![24, 72, 168].includes(durationHours)) return { status: 400, body: { ok: false, error: 'invalid_duration' } };
        if (reason.length < 15 || reason.length > 400 || hasContact) return { status: 400, body: { ok: false, error: 'invalid_reason' } };
        if (suspensionAction[1] === actor.id) return { status: 400, body: { ok: false, error: 'cannot_suspend_self' } };
        if (typeof repository?.issueAccountSuspension !== 'function') return { status: 503, body: { ok: false, error: 'suspensions_unavailable' } };
        try {
          const result = await repository.issueAccountSuspension({ schoolId: actor.school_id, targetId: suspensionAction[1], actorId: actor.id, durationHours, reason });
          return result?.ok ? { status: 201, body: { ok: true, suspension: result.suspension } }
            : { status: result?.code === 'target_unavailable' ? 404 : result?.code === 'already_suspended' ? 409 : 403, body: { ok: false, error: result?.code || 'suspension_failed' } };
        } catch (error) { console.error('account_suspension_issue_failed', error?.message || error); return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      if (input?.action === 'lift') {
        if (suspensionAction[1] === actor.id) return { status: 400, body: { ok: false, error: 'cannot_manage_self' } };
        if (typeof repository?.liftAccountSuspension !== 'function') return { status: 503, body: { ok: false, error: 'suspensions_unavailable' } };
        try {
          const lifted = await repository.liftAccountSuspension({ schoolId: actor.school_id, targetId: suspensionAction[1], actorId: actor.id });
          return lifted ? { status: 200, body: { ok: true, status: 'lifted' } }
            : { status: 409, body: { ok: false, error: 'suspension_unavailable' } };
        } catch (error) { console.error('account_suspension_lift_failed', error?.message || error); return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      return { status: 400, body: { ok: false, error: 'invalid_action' } };
    }
    if (req.method === 'GET' && pathname === '/api/v1/me/suspension') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.id || !actor.school_id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository?.getActiveAccountSuspension !== 'function') return { status: 503, body: { ok: false, error: 'suspension_status_unavailable' } };
      try {
        const suspension = await repository.getActiveAccountSuspension(actor.school_id, actor.id);
        return { status: 200, body: { ok: true, suspended: Boolean(suspension), suspension } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/deletion-requests/targets') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'council_member' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listAccountDeletionTargets !== 'function') return { status: 503, body: { ok: false, error: 'deletion_requests_unavailable' } };
      try { return { status: 200, body: { ok: true, targets: await repository.listAccountDeletionTargets(actor.school_id, actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/deletion-requests') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'council_member' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listOwnAccountDeletionRequests !== 'function') return { status: 503, body: { ok: false, error: 'deletion_requests_unavailable' } };
      try { return { status: 200, body: { ok: true, requests: await repository.listOwnAccountDeletionRequests(actor.school_id, actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/deletion-requests/review') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listPendingAccountDeletionRequests !== 'function') return { status: 503, body: { ok: false, error: 'deletion_requests_unavailable' } };
      try { return { status: 200, body: { ok: true, requests: await repository.listPendingAccountDeletionRequests(actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    const deletionReview = pathname.match(/^\/api\/v1\/deletion-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (req.method === 'PATCH' && deletionReview) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (input?.decision !== 'reject') return { status: 400, body: { ok: false, error: 'unsupported_decision' } };
      const note = typeof input.review_note === 'string' ? input.review_note.trim().slice(0, 240) : '';
      if (typeof repository?.rejectAccountDeletionRequest !== 'function') return { status: 503, body: { ok: false, error: 'deletion_requests_unavailable' } };
      try {
        const rejected = await repository.rejectAccountDeletionRequest(deletionReview[1], actor.school_id, actor.id, note);
        return rejected ? { status: 200, body: { ok: true, status: 'rejected' } }
          : { status: 409, body: { ok: false, error: 'request_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'POST' && pathname === '/api/v1/deletion-requests') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'council_member' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const targetId = typeof input?.target_id === 'string' ? input.target_id : '';
      const reasonCode = input?.reason_code;
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId) || targetId === actor.id) {
        return { status: 400, body: { ok: false, error: 'invalid_target' } };
      }
      if (!['rules_violation', 'harassment', 'fake_account', 'spam', 'other'].includes(reasonCode)) return { status: 400, body: { ok: false, error: 'invalid_reason_code' } };
      if (reason.length < 15 || reason.length > 500) return { status: 400, body: { ok: false, error: 'invalid_reason' } };
      const digits = reason.replace(/\D/g, '');
      if (/(?:https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(reason) || digits.length >= 11) {
        return { status: 400, body: { ok: false, error: 'personal_contact_not_allowed' } };
      }
      if (typeof repository?.createAccountDeletionRequest !== 'function') return { status: 503, body: { ok: false, error: 'deletion_requests_unavailable' } };
      try {
        const result = await repository.createAccountDeletionRequest({ schoolId: actor.school_id, requesterId: actor.id, targetId, reasonCode, reason });
        return result?.ok ? { status: result.already_exists ? 200 : 202, body: result }
          : { status: result?.code === 'requester_unavailable' ? 403 : 404, body: { ok: false, error: result?.code || 'request_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'PATCH' && roleRequestMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      try {
        if (input?.action === 'start_review') {
          const started = await repository.startSchoolRoleRequestReview(roleRequestMatch[1], actor.school_id, actor.id);
          return started ? { status: 200, body: { ok: true, status: 'reviewing' } } : { status: 409, body: { ok: false, error: 'role_request_unavailable' } };
        }
        if (!['approve', 'reject'].includes(input?.decision)) return { status: 400, body: { ok: false, error: 'invalid_decision' } };
        const note = typeof input.review_note === 'string' ? input.review_note.trim().slice(0, 240) : '';
        const updated = await repository.reviewSchoolRoleRequest(roleRequestMatch[1], actor.school_id, actor.id, input.decision, note);
        return updated ? { status: 200, body: { ok: true, status: input.decision === 'approve' ? 'approved' : 'rejected' } }
          : { status: 409, body: { ok: false, error: 'role_request_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'POST' && pathname === '/api/v1/profile-requests') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const result = await requestSchoolProfile({ identity, input, repository });
      const status = result.ok ? 202 : result.code === 'profile_exists' ? 409
        : result.code === 'database_unavailable' ? 503 : 400;
      return { status, body: result };
    }
    if (req.method === 'GET' && pathname === '/api/v1/profile-requests/review') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listPendingSchoolProfileRequests !== 'function') return { status: 503, body: { ok: false, error: 'profile_review_unavailable' } };
      try { return { status: 200, body: { ok: true, requests: await repository.listPendingSchoolProfileRequests(actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'PATCH' && profileRequestMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (!['approve', 'reject'].includes(input?.decision)) return { status: 400, body: { ok: false, error: 'invalid_decision' } };
      try {
        const changed = await repository.reviewSchoolProfileRequest(profileRequestMatch[1], actor.school_id, actor.id, input.decision);
        return changed ? { status: 200, body: { ok: true, status: input.decision === 'approve' ? 'approved' : 'rejected' } }
          : { status: 404, body: { ok: false, error: 'profile_request_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/listings/moderation') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || !['school_admin', 'council_member'].includes(actor.role) || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listPendingListings !== 'function') return { status: 503, body: { ok: false, error: 'moderation_unavailable' } };
      try { return { status: 200, body: { ok: true, listings: await repository.listPendingListings(actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && eventOccupancyMatch) {
      if (typeof repository.getEventOccupancy !== 'function') return { status: 503, body: { ok: false, error: 'event_read_unavailable' } };
      try { return { status: 200, body: { ok: true, taken: await repository.getEventOccupancy(eventOccupancyMatch[1]) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/event-registrations') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      try { return { status: 200, body: { ok: true, registrations: await repository.listEventRegistrations(actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/event-registrations/review') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || !['school_admin', 'council_member'].includes(actor.role) || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      if (typeof repository?.listPendingEventReviews !== 'function') return { status: 503, body: { ok: false, error: 'event_review_unavailable' } };
      try { return { status: 200, body: { ok: true, applications: await repository.listPendingEventReviews(actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'POST' && eventRegistrationMatch) {
      let bodyBytes = 0;
      for await (const chunk of req) {
        bodyBytes += chunk.length;
        if (bodyBytes > 16 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } };
      }
      if (bodyBytes > 0) return { status: 400, body: { ok: false, error: 'unexpected_body' } };
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      try {
        const registration = await repository.registerForEvent(eventRegistrationMatch[1], actor.id);
        return { status: 201, body: { ok: true, registration } };
      } catch (error) {
        if (error?.code === 'event_unavailable') return { status: 404, body: { ok: false, error: 'event_unavailable' } };
        if (error?.code === 'organizer_registration') return { status: 403, body: { ok: false, error: 'organizer_cannot_register' } };
        if (error?.code === 'already_registered') return { status: 409, body: { ok: false, error: 'already_registered' } };
        if (error?.code === 'no_seats_available') return { status: 409, body: { ok: false, error: 'no_seats_available' } };
        return { status: 503, body: { ok: false, error: 'database_unavailable' } };
      }
    }
    if (req.method === 'GET' && eventRegistrationMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (!['school_admin', 'council_member'].includes(actor.role) || !actor.school_id) {
        return { status: 403, body: { ok: false, error: 'forbidden' } };
      }
      if (typeof repository.listEventApplicants !== 'function') {
        return { status: 503, body: { ok: false, error: 'applicant_read_unavailable' } };
      }
      try {
        const applicants = await repository.listEventApplicants(eventRegistrationMatch[1], actor.school_id);
        return { status: 200, body: { ok: true, applicants } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'DELETE' && eventCancellationMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      try {
        const cancelled = await repository.cancelEventRegistration(eventCancellationMatch[1], actor.id);
        return cancelled ? { status: 200, body: { ok: true, status: 'cancelled' } }
          : { status: 404, body: { ok: false, error: 'registration_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'PATCH' && eventReviewMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (!['school_admin', 'council_member'].includes(actor.role)) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const decision = input?.decision === 'approve' ? 'confirmed' : input?.decision === 'reject' ? 'rejected' : null;
      if (!decision) return { status: 400, body: { ok: false, error: 'invalid_decision' } };
      try {
        const updated = await repository.moderateEventRegistration(eventReviewMatch[1], eventReviewMatch[2], actor.id, actor.school_id, decision);
        return updated ? { status: 200, body: { ok: true, status: decision } }
          : { status: 404, body: { ok: false, error: 'registration_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'PATCH' && moderationMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (!['school_admin', 'council_member'].includes(actor.role)) return { status: 403, body: { ok: false, error: 'forbidden' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const status = input?.decision === 'approve' ? 'active' : input?.decision === 'reject' ? 'rejected' : null;
      if (!status) return { status: 400, body: { ok: false, error: 'invalid_decision' } };
      try {
        const updated = await repository.moderateListing(moderationMatch[1], actor.school_id, status);
        return updated ? { status: 200, body: { ok: true, status } } : { status: 404, body: { ok: false, error: 'listing_not_found' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'PATCH' && readMessageMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      try {
        const updated = await repository.markMessageRead(actor.id, actor.school_id, readMessageMatch[1]);
        return updated ? { status: 200, body: { ok: true, is_read: true } } : { status: 404, body: { ok: false, error: 'message_not_found' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/messages') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      try { return { status: 200, body: { ok: true, messages: await repository.listMessages(actor.id, actor.school_id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'POST' && listingContactMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      if (typeof repository?.getListingContactRecipient !== 'function') return { status: 503, body: { ok: false, error: 'contact_unavailable' } };
      try {
        const receiver_id = await repository.getListingContactRecipient(listingContactMatch[1], actor.id, actor.school_id);
        if (!receiver_id) return { status: 404, body: { ok: false, error: 'listing_unavailable' } };
        const result = await submitMessage({ actor, input: { body: input?.body, receiver_id }, repository, review });
        const status = result.ok ? 201 : result.code === 'database_unavailable' || result.status === 'pending' ? 503
          : result.code === 'recipient_unavailable' ? 404 : 400;
        return { status, body: result };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me/listings') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (actor.role !== 'student') return { status: 200, body: { ok: true, listing_ids: [] } };
      if (typeof repository?.listOwnActiveListingIds !== 'function') return { status: 503, body: { ok: false, error: 'own_listings_unavailable' } };
      try { return { status: 200, body: { ok: true, listing_ids: await repository.listOwnActiveListingIds(actor.id) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'DELETE' && ownListingMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || actor.role !== 'student') return { status: 403, body: { ok: false, error: 'student_profile_required' } };
      if (typeof repository?.deleteOwnListing !== 'function') return { status: 503, body: { ok: false, error: 'listing_delete_unavailable' } };
      try {
        const deleted = await repository.deleteOwnListing(actor.id, ownListingMatch[1]);
        if (!deleted) return { status: 404, body: { ok: false, error: 'listing_unavailable' } };
        let imageCleanup = deleted.media_cleanup ? 'queued' : 'not_needed';
        if (deleted.media_cleanup && typeof pendingImages?.delete === 'function'
            && typeof repository.finishPendingImageCleanup === 'function') {
          try {
            await pendingImages.delete(deleted.media_cleanup.object_key);
            if (await repository.finishPendingImageCleanup(deleted.media_cleanup.object_key, deleted.media_cleanup.claim_token, true)) imageCleanup = 'complete';
          } catch { /* The five-minute lease lets the pending-media janitor retry. */ }
        }
        return { status: 200, body: { ok: true, deleted: true, image_cleanup: imageCleanup } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
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
    if (req.method === 'PATCH' && pathname === '/api/v1/me') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let input;
      try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const first_name = typeof input?.first_name === 'string' ? input.first_name.trim() : '';
      const last_name = typeof input?.last_name === 'string' ? input.last_name.trim() : '';
      const class_name = typeof input?.class_name === 'string' ? input.class_name.trim().toUpperCase().replace(/\s+/gu, '') : '';
      const validName = value => value.length >= 1 && value.length <= 60 && !/[<>\u0000-\u001f]/u.test(value);
      if (!validName(first_name) || !validName(last_name) || !/^[1-9][0-9]?[А-ЯЁA-Z]?$/u.test(class_name)) {
        return { status: 400, body: { ok: false, error: 'invalid_profile_identity' } };
      }
      if (typeof repository?.updateOwnProfileIdentity !== 'function') return { status: 503, body: { ok: false, error: 'profile_update_unavailable' } };
      try {
        const profile = await repository.updateOwnProfileIdentity(identity.issuer, identity.subject, { first_name, last_name, class_name });
        return profile ? { status: 200, body: { ok: true, profile } } : { status: 403, body: { ok: false, error: 'profile_unavailable' } };
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
    if (!['/api/v1/listings', '/api/v1/ideas', '/api/v1/messages'].includes(pathname)) return { status: 404, body: { ok: false, error: 'not_found' } };

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
    const result = pathname === '/api/v1/ideas'
      ? await submitIdea({ actor, input, repository, review })
      : pathname === '/api/v1/messages'
        ? await submitMessage({ actor, input, repository, review })
        : await submitListing({ actor, input, repository, review });
    const status = result.ok ? 201
      : result.code === 'database_unavailable' || result.status === 'pending' ? 503
        : result.code === 'forbidden' ? 403
          : result.code === 'recipient_unavailable' ? 404 : 400;
    return { status, body: result };
  };
}
