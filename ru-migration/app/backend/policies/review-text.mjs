import { containsContactData, findLocalPolicyFlag } from './content-safety.js';

// No provider is enabled by default. A later integration must supply an independently
// reviewed Russian provider; these local checks are not an approval classifier.
export async function reviewText(value, { review } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000) {
    return { action: 'reject', reason_code: 'invalid_text' };
  }
  if (containsContactData(value)) {
    return { action: 'reject', reason_code: 'personal_contact_data' };
  }
  const flag = findLocalPolicyFlag(value);
  if (typeof review !== 'function') {
    return { action: 'pending', reason_code: 'review_unavailable', local_flag: flag?.code ?? null };
  }
  try {
    const result = await review({ text: value, localFlag: flag?.code ?? null });
    if (!result || !['ok', 'reject', 'pending'].includes(result.action)) throw new Error('invalid result');
    return { action: result.action, reason_code: typeof result.reason_code === 'string' ? result.reason_code : null, local_flag: flag?.code ?? null };
  } catch {
    return { action: 'pending', reason_code: 'review_unavailable', local_flag: flag?.code ?? null };
  }
}

// Match the source idea moderator's no-provider fallback. Benign ideas can
// proceed to the existing school review; clear local policy flags are rejected,
// while high-risk hate/threat signals stay pending for a human decision.
export function reviewIdeaText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) {
    return { action: 'reject', reason_code: 'invalid_text', local_flag: null };
  }
  if (containsContactData(value)) {
    return { action: 'reject', reason_code: 'personal_contact_data', local_flag: null };
  }
  const flag = findLocalPolicyFlag(value);
  if (flag?.code === 'serious_hate_or_threat' || flag?.code.endsWith('_safety_review')
      || ['targeted_harassment', 'negative_personal_call'].includes(flag?.code)) {
    return { action: 'pending', reason_code: flag.code, local_flag: flag.code };
  }
  if (flag) {
    return { action: 'reject', reason_code: 'unsafe_content', local_flag: flag.code };
  }
  return { action: 'ok', reason_code: 'safe_local_fallback', local_flag: null };
}
