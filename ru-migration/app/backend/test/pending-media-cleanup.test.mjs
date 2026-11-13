import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupPendingMedia } from '../services/cleanup-pending-media.mjs';

const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';

test('cleanup deletes only database-claimed pending objects and records successful removal', async () => {
  const calls = [];
  const result = await cleanupPendingMedia({
    repository: {
      claimExpiredPendingImages: async limit => { assert.equal(limit, 50); return [{ object_key: key, claim_token: 'claim-1' }]; },
      finishPendingImageCleanup: async (...args) => { calls.push(args); return true; },
    },
    pendingImages: { delete: async objectKey => { calls.push(['delete', objectKey]); } },
  });
  assert.deepEqual(result, { claimed: 1, deleted: 1, failed: 0 });
  assert.deepEqual(calls, [['delete', key], [key, 'claim-1', true]]);
});

test('cleanup releases failed deletes for a later retry and refuses malformed keys', async () => {
  const calls = [];
  const result = await cleanupPendingMedia({
    repository: {
      claimExpiredPendingImages: async () => [
        { object_key: key, claim_token: 'claim-1' },
        { object_key: 'pending/../../other.webp', claim_token: 'claim-2' },
      ],
      finishPendingImageCleanup: async (...args) => { calls.push(args); return true; },
    },
    pendingImages: { delete: async () => { throw new Error('storage unavailable'); } },
  });
  assert.deepEqual(result, { claimed: 2, deleted: 0, failed: 2 });
  assert.deepEqual(calls, [[key, 'claim-1', false], ['pending/../../other.webp', 'claim-2', false]]);
});

test('cleanup refuses unbounded batches and incomplete dependencies', async () => {
  await assert.rejects(cleanupPendingMedia({ limit: 1000 }), TypeError);
  await assert.rejects(cleanupPendingMedia({ repository: {}, pendingImages: {} }), TypeError);
});
