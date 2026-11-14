import { reviewText } from '../policies/review-text.mjs';
import { recordLocalSafetySignal } from '../policies/safety-signal.mjs';

export async function submitIdea({ actor, input, repository, review, safetyKey }) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) return { ok: false, code: 'unauthenticated' };
  if (typeof actor.school_id !== 'string' || !actor.school_id.trim()) return { ok: false, code: 'school_required' };
  if (!input || typeof input.text !== 'string') return { ok: false, code: 'invalid_idea' };
  const text = input.text.trim();
  if (text.length < 2 || text.length > 1000) return { ok: false, code: 'invalid_idea' };
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
      ai_status: decision.action === 'pending' ? 'pending' : 'approved',
      ai_summary: text.slice(0, 60),
      ai_reason: decision.reason_code || '',
      admin_status: 'new',
    });
    if (!idea || typeof idea.id !== 'string') return { ok: false, code: 'database_unavailable' };
    return { ok: true, status: decision.action === 'pending' ? 'pending' : 'approved', id: idea.id };
  } catch {
    return { ok: false, code: 'database_unavailable' };
  }
}
