import { reviewText } from '../policies/review-text.mjs';
import { recordLocalSafetySignal } from '../policies/safety-signal.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function submitIdea({ actor, input, repository, review, safetyKey }) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) return { ok: false, code: 'unauthenticated' };
  if (typeof actor.school_id !== 'string' || !actor.school_id.trim()) return { ok: false, code: 'school_required' };
  if (!input || typeof input.text !== 'string') return { ok: false, code: 'invalid_idea' };
  const text = input.text.trim();
  if (text.length < 2 || text.length > 1000) return { ok: false, code: 'invalid_idea' };
  const imageKeys = input.image_keys == null ? [] : input.image_keys;
  const imageKeyPattern = /^pending\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;
  if (!Array.isArray(imageKeys) || imageKeys.length > 3
      || (imageKeys.length > 0 && !UUID.test(actor.id))
      || imageKeys.some(key => typeof key !== 'string' || !imageKeyPattern.test(key))
      || new Set(imageKeys).size !== imageKeys.length) return { ok: false, code: 'invalid_idea' };
  const decision = await reviewText(text, { review });
  try {
    await recordLocalSafetySignal({ actor, sourceKind: 'idea', sourceOrigin: 'ideas',
      localFlag: decision.local_flag, text, safetyKey, repository });
  } catch { return { ok: false, code: 'safety_signal_unavailable', status: decision.action }; }
  if (decision.action === 'reject') return { ok: false, code: decision.reason_code || 'rejected', status: 'rejected' };
  if (!repository || typeof repository.createIdea !== 'function') return { ok: false, code: 'database_unavailable' };
  try {
    const idea = await repository.createIdea({
      user_id: actor.id,
      school_id: actor.school_id,
      text,
      image_keys: imageKeys,
      image_status: imageKeys.length ? 'pending' : 'none',
      ai_status: decision.action === 'pending' ? 'pending' : 'approved',
      ai_summary: text.slice(0, 60),
      ai_reason: decision.reason_code || '',
      admin_status: 'new',
    });
    if (!idea || typeof idea.id !== 'string') return { ok: false, code: 'database_unavailable' };
    return { ok: true, status: decision.action === 'pending' ? 'pending' : 'approved', image_status: imageKeys.length ? 'pending' : 'none', id: idea.id };
  } catch {
    return { ok: false, code: 'database_unavailable' };
  }
}
