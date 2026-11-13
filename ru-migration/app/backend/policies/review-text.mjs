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
    return { action: result.action, reason_code: typeof result.reason_code === 'string' ? result.reason_code : null };
  } catch {
    return { action: 'pending', reason_code: 'review_unavailable', local_flag: flag?.code ?? null };
  }
}
