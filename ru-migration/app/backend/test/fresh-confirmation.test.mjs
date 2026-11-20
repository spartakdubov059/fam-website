import test from 'node:test';
import assert from 'node:assert/strict';
import { hasFreshConfirmation } from '../auth/fresh-confirmation.mjs';

const now = 1_900_000_000_000;

test('fresh confirmation accepts only a recent provider-authenticated timestamp', () => {
  assert.equal(hasFreshConfirmation({ authenticated_at: now / 1000 }, now), true);
  assert.equal(hasFreshConfirmation({ authenticated_at: now / 1000 - 600 }, now), true);
  assert.equal(hasFreshConfirmation({ authenticated_at: now / 1000 - 601 }, now), false);
  assert.equal(hasFreshConfirmation({ authenticated_at: now / 1000 + 6 }, now), false);
});

test('OAuth consent and local session issuance never count as fresh authentication', () => {
  const consentAt = now / 1000;
  assert.equal(hasFreshConfirmation({ authenticated_at: null, step_up_confirmed_at: consentAt }, now), false);
  assert.equal(hasFreshConfirmation({ authenticated_at: null, session_issued_at: consentAt }, now), false);
});
