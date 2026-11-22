export function hasFreshConfirmation(identity, now = Date.now(), maxAgeSeconds = 600) {
  if (!identity || !Number.isFinite(now) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) return false;
  const nowSeconds = Math.floor(now / 1000);
  // A local session timestamp or OAuth consent screen is not fresh identity
  // proof. Step-up is accepted only after an email challenge was verified and
  // the backend attached its timestamp from a signed, identity-bound cookie.
  const value = identity.step_up_confirmed_at ?? identity.authenticated_at;
  return Number.isInteger(value) && value <= nowSeconds + 5 && value >= nowSeconds - maxAgeSeconds;
}
