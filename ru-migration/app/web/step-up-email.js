async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export async function requestWithEmailStepUp({ fetchImpl = globalThis.fetch, url, init, promptImpl = globalThis.prompt } = {}) {
  if (typeof fetchImpl !== 'function' || typeof url !== 'string' || !init || typeof init !== 'object') {
    throw new TypeError('step-up request configuration is required');
  }
  const firstResponse = await fetchImpl(url, init);
  const firstResult = await readJson(firstResponse);
  if (firstResult?.error !== 'fresh_authentication_required') return { response: firstResponse, result: firstResult };

  const sent = await fetchImpl('/api/v1/me/step-up/email', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ action: 'send' }) });
  const sendResult = await readJson(sent);
  if (!sent.ok || sendResult?.ok !== true) return { response: firstResponse, result: firstResult, stepUpError: sendResult?.error || 'step_up_unavailable' };
  if (typeof promptImpl !== 'function') return { response: firstResponse, result: firstResult, stepUpError: 'code_entry_unavailable' };
  const code = promptImpl('Введите шестизначный код из письма для подтверждения действия. Код действует 10 минут.');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return { response: firstResponse, result: firstResult, stepUpError: 'code_entry_cancelled' };
  }
  const verified = await fetchImpl('/api/v1/me/step-up/email', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ action: 'verify', code: code.trim() }) });
  const verifyResult = await readJson(verified);
  if (!verified.ok || verifyResult?.ok !== true) {
    return { response: firstResponse, result: firstResult, stepUpError: verifyResult?.error || 'code_verification_failed' };
  }
  const response = await fetchImpl(url, init);
  return { response, result: await readJson(response), stepUpError: response.status === 403 ? 'step_up_retry_rejected' : null };
}
