import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverIncompleteAccountDeletions } from '../services/recover-account-deletions.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const key = `pending/${userId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
const job = { user_id: userId, issuer: 'https://issuer.example', subject: 'synthetic', school_id: 'school-a', claim_token: 'claim-a' };

test('manual recovery re-lists owner media, deletes it and finalizes the leased job', async () => {
  const calls = [];
  const result = await recoverIncompleteAccountDeletions({ repository: {
    listAccountMediaKeys: async () => [],
    claimIncompleteAccountDeletions: async limit => { calls.push(['claim', limit]); return [job]; },
    finishAccountDeletion: async input => { calls.push(['finish', input]); return { ok: true }; },
  }, pendingImages: {
    listUserObjects: async id => { calls.push(['list', id]); return [key]; },
    listAccountObjects: async id => { calls.push(['list', id]); return [key]; },
    delete: async imageKey => calls.push(['delete', imageKey]),
  } });
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(calls.map(call => call[0]), ['claim', 'list', 'delete', 'finish']);
  assert.deepEqual(calls[3][1], { issuer: job.issuer, subject: job.subject, userId, schoolId: job.school_id, claimToken: 'claim-a' });
});

test('manual recovery leaves the durable job for retry when inventory contains another owner key', async () => {
  let deleted = false; let finished = false;
  const result = await recoverIncompleteAccountDeletions({ repository: {
    listAccountMediaKeys: async () => [],
    claimIncompleteAccountDeletions: async () => [job],
    finishAccountDeletion: async () => { finished = true; return { ok: true }; },
  }, pendingImages: {
    listUserObjects: async () => ['pending/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'],
    listAccountObjects: async () => ['pending/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'],
    delete: async () => { deleted = true; },
  } });
  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1 });
  assert.equal(deleted, false);
  assert.equal(finished, false);
});
