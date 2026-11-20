export function hasFreshConfirmation(identity, now = Date.now(), maxAgeSeconds = 600) {
  if (!identity || !Number.isFinite(now) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) return false;
  const nowSeconds = Math.floor(now / 1000);
  // Only a provider-asserted authentication time is evidence of recent
  // authentication. OAuth consent prompts and local session issuance do not
  // establish that the user re-authenticated.
  const value = identity.authenticated_at;
  return Number.isInteger(value) && value <= nowSeconds + 5 && value >= nowSeconds - maxAgeSeconds;
}
