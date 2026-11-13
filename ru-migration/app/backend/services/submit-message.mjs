import { reviewText } from '../policies/review-text.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function submitMessage({ actor, input, repository, review }) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) return { ok: false, code: 'unauthenticated' };
  if (typeof actor.school_id !== 'string' || !actor.school_id.trim()) return { ok: false, code: 'school_required' };
  if (!input || typeof input.body !== 'string' || typeof input.receiver_id !== 'string') return { ok: false, code: 'invalid_message' };
  const body = input.body.trim();
  const receiverId = input.receiver_id;
  if (!body || body.length > 1000 || !UUID_RE.test(receiverId) || receiverId === actor.id) {
    return { ok: false, code: 'invalid_message' };
  }
  const decision = await reviewText(body, { review });
  if (decision.action !== 'ok') {
    return { ok: false, code: decision.reason_code || (decision.action === 'pending' ? 'review_pending' : 'rejected'), status: decision.action };
  }
  if (!repository || typeof repository.createMessage !== 'function') return { ok: false, code: 'database_unavailable' };
  try {
    const message = await repository.createMessage({ sender_id: actor.id, receiver_id: receiverId, school_id: actor.school_id, body });
    if (!message || typeof message.id !== 'string') return { ok: false, code: 'database_unavailable' };
    return { ok: true, status: 'approved', id: message.id };
  } catch (error) {
    if (error?.code === 'recipient_unavailable') return { ok: false, code: 'recipient_unavailable' };
    return { ok: false, code: 'database_unavailable' };
  }
}
