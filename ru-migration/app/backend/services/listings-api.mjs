import { submitListing } from './submit-listing.mjs';
import { submitIdea } from './submit-idea.mjs';
import { submitMessage } from './submit-message.mjs';
import { requestSchoolProfile } from './request-school-profile.mjs';
import { SCHOOL_CATALOG } from '../policies/school-catalog.mjs';

export function createListingsApi({ authenticate, resolveActor, repository, review, schools = SCHOOL_CATALOG }) {
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const readMessageMatch = pathname.match(/^\/api\/v1\/messages\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/read$/i);
    const listingContactMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/contact$/i);
    const moderationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/moderation$/i);
    const eventOccupancyMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/occupancy$/i);
    const eventRegistrationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations$/i);
    const eventReviewMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const eventCancellationMatch = pathname.match(/^\/api\/v1\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/registrations\/me$/i);
    const profileRequestMatch = pathname.match(/^\/api\/v1\/profile-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
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
