export function hasFreshConfirmation(identity, now = Date.now(), maxAgeSeconds = 600) {
  if (!identity || !Number.isFinite(now) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) return false;
  const nowSeconds = Math.floor(now / 1000);
  return [identity.authenticated_at, identity.step_up_confirmed_at].some(value =>
    Number.isInteger(value) && value <= nowSeconds + 5 && value >= nowSeconds - maxAgeSeconds);
}
