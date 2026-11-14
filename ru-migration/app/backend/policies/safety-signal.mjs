import { createHmac } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildLocalSafetySignal({ actor, targetId = null, sourceKind, sourceOrigin, localFlag, text, safetyKey }) {
  if (localFlag !== 'serious_hate_or_threat') return null;
  if (!actor || !UUID.test(actor.id || '') || typeof actor.school_id !== 'string' || !actor.school_id
      || (targetId !== null && !UUID.test(targetId)) || !['message', 'idea', 'listing'].includes(sourceKind)
      || typeof sourceOrigin !== 'string' || !/^[a-z0-9.-]{1,120}$/.test(sourceOrigin)
      || typeof safetyKey !== 'string' || Buffer.byteLength(safetyKey) < 32) {
    throw new TypeError('safety signal configuration is incomplete');
  }
  const pair = [actor.id, targetId || 'unpaired'].sort().join('|');
  const fingerprint = createHmac('sha256', safetyKey)
    .update(`fam-ru-safety-fingerprint-v1|${actor.school_id}|${pair}`)
    .digest('hex');
  const normalized = String(text || '').normalize('NFKC').toLocaleLowerCase('ru-RU');
  const category = /ненавист|дискриминац|расист|нацист/u.test(normalized) ? 'hate_or_discrimination'
    : /угроз|убей|убить|расправ/u.test(normalized) ? 'threat_or_intimidation'
      : 'unclear_safety_signal';
  return {
    schoolId: actor.school_id,
    fingerprint,
    sourceKind,
    category,
    severity: category === 'unclear_safety_signal' ? 'medium' : 'high',
    actorId: actor.id,
    targetId,
    sourceOrigin,
  };
}

export async function recordLocalSafetySignal({ repository, ...input }) {
  const signal = buildLocalSafetySignal(input);
  if (!signal) return false;
  if (typeof repository?.recordSafetySignal !== 'function') throw new Error('safety signal storage is unavailable');
  const saved = await repository.recordSafetySignal(signal);
  if (!saved) throw new Error('safety signal storage is unavailable');
  return true;
}
