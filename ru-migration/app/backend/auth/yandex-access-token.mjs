const USERINFO_URL = 'https://login.yandex.ru/info?format=json';

export async function resolveYandexIdentityFromAccessToken({ accessToken, clientId, fetchImpl = globalThis.fetch } = {}) {
  if (typeof accessToken !== 'string' || accessToken.length < 16 || accessToken.length > 4096
      || typeof clientId !== 'string' || !clientId.trim() || typeof fetchImpl !== 'function') {
    throw new TypeError('invalid Yandex access token verification input');
  }
  let response;
  try {
    response = await fetchImpl(USERINFO_URL, {
      headers: { accept: 'application/json', authorization: `OAuth ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('Yandex identity verification unavailable');
  }
  if (!response?.ok) throw new Error('Yandex identity verification rejected');
  let profile;
  try { profile = await response.json(); } catch { throw new Error('Yandex identity response invalid'); }
  if (profile?.client_id !== clientId || typeof profile.id !== 'string' || !/^\d{1,32}$/.test(profile.id)) {
    throw new Error('Yandex identity did not match configured application');
  }
  return Object.freeze({ issuer: 'https://login.yandex.ru', subject: profile.id });
}
