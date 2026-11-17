import { reviewText } from '../policies/review-text.mjs';
import { recordLocalSafetySignal } from '../policies/safety-signal.mjs';

const CATEGORIES = new Set(['Вещи', 'Услуги', 'Творчество', 'Учёба', 'Мероприятия']);

// actor and repository must come from the server's authentication and database
// adapters, never from request JSON. This service is not exposed as an HTTP route
// until those adapters and their authorization checks are available.
export async function submitListing({ actor, input, repository, review, safetyKey }) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) return { ok: false, code: 'unauthenticated' };
  if (!input || typeof input !== 'object' || typeof input.title !== 'string' || typeof input.description !== 'string' || !CATEGORIES.has(input.category)) {
    return { ok: false, code: 'invalid_listing' };
  }
  if (typeof actor.school_id !== 'string' || !actor.school_id.trim()) return { ok: false, code: 'school_required' };
  const title = input.title.trim();
  const description = input.description.trim();
  const price = input.price_text == null ? 'Бесплатно' : typeof input.price_text === 'string' ? input.price_text.trim() : null;
  const imageKey = typeof input.image_key === 'string' ? input.image_key : null;
  const safeImageKey = imageKey && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor.id)
    && new RegExp(`^pending/${actor.id}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`, 'i').test(imageKey);
  if (!title || title.length > 80 || !description || description.length > 1000 || price === null || price.length > 50
      || input.image_url || input.imageUrl || (input.image_key != null && !safeImageKey)) {
    return { ok: false, code: 'invalid_listing' };
  }
  const isEvent = input.category === 'Мероприятия';
  if (isEvent && !['school_admin', 'council_member'].includes(actor.role)) return { ok: false, code: 'forbidden' };
  const eventType = isEvent ? (input.event_type ?? 'open') : null;
  const maxSeats = isEvent && eventType === 'limited' ? Number(input.max_seats) : 0;
  if (isEvent && (!['open', 'request', 'limited'].includes(eventType) || (eventType === 'limited' && (!Number.isInteger(maxSeats) || maxSeats < 1 || maxSeats > 500)))) return { ok: false, code: 'invalid_listing' };
  const eventDate = isEvent && typeof input.event_date === 'string' ? input.event_date : null;
  const eventTime = isEvent && typeof input.event_time === 'string' ? input.event_time : null;
  if ((eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) || (eventTime && !/^\d{2}:\d{2}$/.test(eventTime))) return { ok: false, code: 'invalid_listing' };
  const decision = await reviewText([title, description, price].join('\n'), { review });
  try {
    await recordLocalSafetySignal({ actor, sourceKind: 'listing', sourceOrigin: 'listings',
      localFlag: decision.local_flag, text: [title, description, price].join('\n'), safetyKey, repository });
  } catch { return { ok: false, code: 'safety_signal_unavailable', status: decision.action }; }
  if (decision.action === 'reject') return { ok: false, code: decision.reason_code || 'rejected', status: 'rejected' };
  // Unreviewed content is stored only as pending and remains invisible to public listing queries.
  if (!repository || typeof repository.createListing !== 'function') return { ok: false, code: 'database_unavailable' };
  try {
    const listing = await repository.createListing({ user_id: actor.id, school_id: actor.school_id, title, description, category: input.category, price_text: price || 'Бесплатно', is_event: isEvent, event_date: eventDate, event_time: eventTime, event_type: eventType, max_seats: maxSeats, image_key: imageKey, photo_status: imageKey ? 'pending' : 'none', status: 'pending' });
    if (!listing || typeof listing.id !== 'string') return { ok: false, code: 'database_unavailable' };
    return { ok: true, status: 'pending', id: listing.id };
  } catch {
    return { ok: false, code: 'database_unavailable' };
  }
}
