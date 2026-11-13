import { reviewText } from '../policies/review-text.mjs';

const CATEGORIES = new Set(['Вещи', 'Услуги', 'Творчество', 'Учёба', 'Мероприятия']);

// actor and repository must come from the server's authentication and database
// adapters, never from request JSON. This service is not exposed as an HTTP route
// until those adapters and their authorization checks are available.
export async function submitListing({ actor, input, repository, review }) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) return { ok: false, code: 'unauthenticated' };
  if (!input || typeof input !== 'object' || typeof input.title !== 'string' || typeof input.description !== 'string' || !CATEGORIES.has(input.category)) {
    return { ok: false, code: 'invalid_listing' };
  }
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title || title.length > 200 || !description || description.length > 8000 || input.image_url || input.imageUrl) {
    return { ok: false, code: 'invalid_listing' };
  }
  const decision = await reviewText(`${title}\n${description}`, { review });
  if (decision.action !== 'ok') return { ok: false, code: decision.reason_code || 'review_pending', status: decision.action };
  if (!repository || typeof repository.createListing !== 'function') return { ok: false, code: 'database_unavailable' };
  try {
    const listing = await repository.createListing({ user_id: actor.id, title, description, category: input.category, status: 'pending' });
    if (!listing || typeof listing.id !== 'string') return { ok: false, code: 'database_unavailable' };
    return { ok: true, status: 'pending', id: listing.id };
  } catch {
    return { ok: false, code: 'database_unavailable' };
  }
}
