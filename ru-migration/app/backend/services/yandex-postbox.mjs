const POSTBOX_SEND_URL = 'https://postbox.cloud.yandex.net/v2/email/outbound-emails';

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

export function createYandexPostboxSender({ fromEmail, fetchImpl = globalThis.fetch } = {}) {
  if (!validEmail(fromEmail) || typeof fetchImpl !== 'function') return null;
  return async function sendRoleEmailVerification({ to, code, accessToken }) {
    if (!validEmail(to) || !/^\d{6}$/.test(code || '') || typeof accessToken !== 'string'
        || accessToken.length < 20 || accessToken.length > 4096) throw new TypeError('invalid Postbox verification request');
    const response = await fetchImpl(POSTBOX_SEND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yacloud-subjecttoken': accessToken },
      body: JSON.stringify({
        FromEmailAddress: fromEmail,
        Destination: { ToAddresses: [to] },
        Content: { Simple: {
          Subject: { Data: 'Код подтверждения FAM', Charset: 'UTF-8' },
          Body: { Text: { Data: `Код подтверждения: ${code}\n\nОн действует 10 минут. Если вы не запрашивали код, проигнорируйте письмо.`, Charset: 'UTF-8' } },
        } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Postbox rejected the verification message');
  };
}
