Warning: truncated output (original token count: 22873)
Total output lines: 1092

import { submitListing } from './submit-listing.mjs';
import { submitIdea } from './submit-idea.mjs';
import { submitMessage } from './submit-message.mjs';
import { isSchoolClassName } from '../policies/school-catalog.mjs';
import { requestSchoolProfile } from './request-school-profile.mjs';
import { createSchoolPulseApi } from './school-pulse-api.mjs';
import { createAccountDeletionApi } from './account-deletion-api.mjs';
import { SCHOOL_CATALOG } from '../policies/school-catalog.mjs';
import { createSiteErrorTelemetry } from './site-error-telemetry.mjs';
import { hasFreshConfirmation } from '../auth/fresh-confirmation.mjs';

export function createListingsApi({ authenticate, resolveActor, repository, review, safetyKey, schools = SCHOOL_CATALOG, pendingImages = null, now = Date.now }) {
  const schoolPulseApi = createSchoolPulseApi({ authenticate, resolveActor, repository, now });
  const accountDeletionApi = createAccountDeletionApi({ authenticate, resolveActor, repository, pendingImages, now });
  const siteErrorTelemetry = createSiteErrorTelemetry({ repository, now: () => new Date(now()) });
  const schoolRoleSuspensionGate = async (actor) => {
    if (typeof repository?.getActiveAccountSuspension !== 'function') {
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
    if (pathname === '/api/v1/notification-reads' && (req.method === 'GET' || req.method === 'POST')) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (req.method === 'GET') {
        if (typeof repository?.listNotificationReadStates !== 'function') return { status: 503, body: { ok: false, error: 'notification_state_unavailable' } };
        try {
          const notificationKeys = await repository.listNotificationReadStates(actor.id);
          if (!Array.isArray(notificationKeys) || notificationKeys.length > 10_000) {
            return { status: 503, body: { ok: false, error: 'notification_state_incomplete' } };
          }
          return { status: 200, body: { ok: true, notification_keys: notificationKeys.map(row => row.notification_key) } };
        } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const keys = input?.notification_keys;
      if (!Array.isArray(keys) || keys.length > 100 || keys.some(key => typeof key !== 'string'
          || key.length < 1 || key.length > 220 || /[\u0000-\u001f\u007f]/u.test(key))) {
        return { status: 400, body: { ok: false, error: 'invalid_notification_keys' } };
      }
      if (typeof repository?.saveNotificationReadStates !== 'function') return { status: 503, body: { ok: false, error: 'notification_state_unavailable' } };
      try {
        await repository.saveNotificationReadStates(actor.id, [...new Set(keys)]);
        return { status: 200, body: { ok: true } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (pathname === '/api/v1/site-errors') return siteErrorTelemetry(req);
    if (pathname === '/api/v1/me/account') return accountDeletionApi(req);
    if (req.method === 'DELETE' && /^\/api\/v1\/school\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname)) return accountDeletionApi(req);
    if (req.method === 'PATCH' && /^\/api\/v1\/deletion-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname)) return accountDeletionApi(req);
    if (pathname === '/api/v1/pulse' || pathname.startsWith('/api/v1/pulse/')) return schoolPulseApi(req);
    const readMessageMatch = pathname.match(/^\/api\/v1\/messages\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/read$/i);
    const avatarReviewMatch = pathname.match(/^\/api\/v1\/avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/moderation$/i);
    const pendingMessageReviewMatch = pathname.match(/^\/api\/v1\/messages\/moderation\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const staffVerificationMatch = pathname.match(/^\/api\/v1\/staff-verifications\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const schoolIdeaImageReviewMatch = pathname.match(/^\/api\/v1\/school\/ideas\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/images$/i);
    const schoolIdeaTextReviewMatch = pathname.match(/^\/api\/v1\/school\/ideas\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/moderation$/i);
    const schoolIdeaWorkflowMatch = pathname.match(/^\/api\/v1\/school\/ideas\/workflow\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/status$/i);
    const listingContactMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/contact$/i);
    const schoolListingDeleteMatch = pathname.match(/^\/api\/v1\/school\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const ownListingMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const schoolIdeaDeleteMatch = pathname.match(/^\/api\/v1\/ideas\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const moderationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/moderation$/i);
    const eventOccupancyMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/occupancy$/i);
    const eventRegistrationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations$/i);
    const eventReviewMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const eventCancellationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations\/me$/i);
    const profileRequestMatch = pathname.match(/^\/api\/v1\/profile-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const roleRequestMatch = pathname.match(/^\/api\/v1\/role-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if ((req.method === 'GET' || req.method === 'PATCH') && pathname === '/api/v1/school/admin/safety-reports') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id || !actor.id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      const suspensionBlock = await schoolRoleSuspensionGate(actor);
      if (suspensionBlock) return suspensionBlock;
      if (req.method === 'GET') {
        if (typeof repository?.listSchoolSafetyReports !== 'function') return { status: 503, body: { ok: false, error: 'safety_reports_unavailable' } };
        try { return { status: 200, body: { ok: true, ...(await repository.listSchoolSafetyReports(actor.school_id)) } }; }
        catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      }
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
      const validFingerprint = typeof input?.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(input.fingerprint);
      const validCategory = ['targeted_harassment', 'hate_or_discrimination', 'threat_or_intimidation', 'negative_personal_call',
        'spam_or_repeated_abuse', 'unsafe_image', 'personal_data_in_image', 'unclear_safety_signal'].includes(input?.category);
      const validSource = ['message', 'idea', 'listing', 'image'].includes(input?.source_kind);
      if (!validFingerprint || !validCategory || !validSource) return { status: 400, body: { ok: false, error: 'invalid_safety_report' } };
      if (typeof repository?.acknowledgeSchoolSafetyReport !== 'function') return { status: 503, body: { ok: false, error: 'safety_reports_unavailable' } };
      try {
        const updated = await repository.acknowledgeSchoolSafetyReport({ schoolId: actor.school_id, reviewerId: actor.id,
          fingerprint: input.fingerprint, category: input.category, sourceKind: input.source_kind });
        return updated ? { status: 200, body: { ok: true } } : { status: 404, body: { ok: false, error: 'safety_report_unavailable' } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/school/admin/overview') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      const suspensionBlock = await schoolRoleSuspensionGate(actor);
      if (suspensionBlock) return suspensionBlock;
      if (typeof repository?.getSchoolAdminOverview !== 'function') return { status: 503, body: { ok: false, error: 'overview_unavailable' } };
      try { return { status: 200, body: { ok: true, ...(await repository.getSchoolAdminOverview(actor.school_id)) } }; }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'GET' && pathname === '/api/v1/school/admin/agent-dashboard') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (actor?.role !== 'school_admin' || !actor.school_id) return { status: 403, body: { ok: false, error: 'forbidden' } };
      const suspensionBlock = await schoolRoleSuspensionGate(actor);
      if (suspensionBlock) return suspensionBlock;
      if (typeof repository?.getSchoolAgentDashboard…16873 tokens truncated…lete';
          } catch { /* The five-minute lease lets the pending-media janitor retry. */ }
        }
        return { status: 200, body: { ok: true, deleted: true, image_cleanup: imageCleanup } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
    }
    if (req.method === 'DELETE' && schoolIdeaDeleteMatch) {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.id || !actor.school_id) return { status: 403, body: { ok: false, error: 'school_profile_required' } };
      if (typeof repository?.getSchoolIdeaDeletionContext !== 'function' || typeof repository?.deleteSchoolIdea !== 'function') {
        return { status: 503, body: { ok: false, error: 'idea_delete_unavailable' } };
      }
      let context;
      try { context = await repository.getSchoolIdeaDeletionContext({ ideaId: schoolIdeaDeleteMatch[1], schoolId: actor.school_id }); }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      if (!context) return { status: 404, body: { ok: false, error: 'idea_unavailable' } };
      if (context.user_id !== actor.id) {
        if (actor.role !== 'school_admin') return { status: 403, body: { ok: false, error: 'forbidden' } };
        let input;
        try { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) return { status: 413, body: { ok: false, error: 'request_too_large' } }; chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return { status: 400, body: { ok: false, error: 'invalid_json' } }; }
        if (input?.confirmation !== 'УДАЛИТЬ ИДЕЮ ШКОЛЫ') return { status: 400, body: { ok: false, error: 'confirmation_required' } };
      }
      let deleted;
      try { deleted = await repository.deleteSchoolIdea({ ideaId: schoolIdeaDeleteMatch[1], actorId: actor.id, schoolId: actor.school_id }); }
      catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
      if (!deleted?.ok) return { status: deleted?.code === 'forbidden' ? 403 : 404, body: { ok: false, error: deleted?.code || 'idea_unavailable' } };
      let imageCleanup = deleted.media_cleanup?.length ? 'queued' : 'not_needed';
      if (deleted.media_cleanup?.length && typeof pendingImages?.delete === 'function'
          && typeof repository.finishPendingImageCleanup === 'function') {
        let complete = true;
        for (const media of deleted.media_cleanup) {
          try {
            await pendingImages.delete(media.object_key);
            if (!await repository.finishPendingImageCleanup(media.object_key, media.claim_token, true)) complete = false;
          } catch { complete = false; }
        }
        imageCleanup = complete ? 'complete' : 'queued';
      }
      return { status: 200, body: { ok: true, deleted: true, image_cleanup: imageCleanup } };
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
      let currentProfile;
      if (input?.person_type == null || input?.staff_position == null || input?.class_name == null) {
        try { currentProfile = await resolveActor(identity); } catch { currentProfile = null; }
      }
      const person_type = input?.person_type ?? currentProfile?.person_type ?? 'student';
      const staff_position = typeof input?.staff_position === 'string' ? input.staff_position.trim() : (currentProfile?.staff_position ?? '');
      const class_name = typeof input?.class_name === 'string' ? input.class_name.trim().toUpperCase().replace(/\s+/gu, '')
        : (currentProfile?.class_name ?? '');
      const validName = value => value.length >= 1 && value.length <= 60 && !/[<>\u0000-\u001f]/u.test(value);
      if (!validName(first_name) || !validName(last_name) || !['student', 'school_staff', 'parent'].includes(person_type)
          || (person_type === 'student' && !isSchoolClassName(class_name))
          || (person_type !== 'student' && class_name !== '')
          || (person_type === 'school_staff' && (staff_position.length < 1 || staff_position.length > 100 || /[<>\u0000-\u001f]/u.test(staff_position)))
          || (person_type !== 'school_staff' && staff_position !== '')) {
        return { status: 400, body: { ok: false, error: 'invalid_profile_identity' } };
      }
      if (typeof repository?.updateOwnProfileIdentity !== 'function') return { status: 503, body: { ok: false, error: 'profile_update_unavailable' } };
      try {
        const profile = await repository.updateOwnProfileIdentity(identity.issuer, identity.subject,
          { first_name, last_name, class_name, person_type, staff_position });
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
      // Match the source FAM board policy: active listings are visible only
      // to signed-in profiles from the same school. Guests receive an empty
      // feed so the UI can show its login prompt without leaking school data.
      let identity;
      try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 200, body: { ok: true, listings: [] } };
      let actor;
      try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor?.school_id) return { status: 200, body: { ok: true, listings: [] } };
      if (typeof repository.listActiveListings !== 'function') {
        return { status: 503, body: { ok: false, error: 'listing_read_unavailable' } };
      }
      try {
        const listings = await repository.listActiveListings(actor.school_id);
        return { status: 200, body: { ok: true, listings } };
      } catch {
        return { status: 503, body: { ok: false, error: 'database_unavailable' } };
      }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me/ideas') {
      let identity; try { identity = await authenticate(req); } catch { identity = null; }
      if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
      let actor; try { actor = await resolveActor(identity); } catch { actor = null; }
      if (!actor || typeof actor.id !== 'string' || !actor.school_id) return { status: 403, body: { ok: false, error: 'profile_unavailable' } };
      if (typeof repository?.listOwnIdeas !== 'function') return { status: 503, body: { ok: false, error: 'ideas_unavailable' } };
      try {
        const ideas = await repository.listOwnIdeas(actor.id, actor.school_id);
        return { status: 200, body: { ok: true, ideas: Array.isArray(ideas) ? ideas.slice(0, 50) : [] } };
      } catch { return { status: 503, body: { ok: false, error: 'database_unavailable' } }; }
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
      ? await submitIdea({ actor, input, repository, review, safetyKey })
      : pathname === '/api/v1/messages'
        ? await submitMessage({ actor, input, repository, review, safetyKey })
        : await submitListing({ actor, input, repository, review, safetyKey });
    const status = result.ok ? 201
      : result.code === 'database_unavailable' || result.status === 'pending' ? 503
        : result.code === 'forbidden' ? 403
          : result.code === 'recipient_unavailable' ? 404 : result.code === 'rate_limited' ? 429 : 400;
    return { status, body: result };
  };
}
