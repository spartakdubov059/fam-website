const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const USER_ID = new RegExp(`^${UUID}$`, 'i');
const IMAGE_KEY = new RegExp(`^pending/${UUID}/${UUID}\\.webp$`, 'i');

export function createAccountDeletionRecoveryOperation({ repository, pendingImages } = {}) {
  if (typeof repository?.claimIncompleteAccountDeletions !== 'function'
      || typeof repository?.finishAccountDeletion !== 'function'
      || typeof pendingImages?.listUserObjects !== 'function' || typeof pendingImages?.delete !== 'function') return null;
  return (limit = 10) => recoverIncompleteAccountDeletions({ repository, pendingImages, limit });
}

export async function recoverIncompleteAccountDeletions({ repository, pendingImages, limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('invalid account deletion recovery limit');
  const claims = await repository.claimIncompleteAccountDeletions(limit);
  if (!Array.isArray(claims)) throw new Error('invalid account deletion recovery claims');
  const result = { claimed: claims.length, completed: 0, failed: 0 };
  for (const job of claims) {
    if (!job || !USER_ID.test(job.user_id) || typeof job.issuer !== 'string' || !job.issuer
        || typeof job.subject !== 'string' || !job.subject || typeof job.school_id !== 'string' || !job.school_id
        || typeof job.claim_token !== 'string' || !job.claim_token) {
      result.failed++;
      continue;
    }
    try {
      const keys = await pendingImages.listUserObjects(job.user_id);
      if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !IMAGE_KEY.test(key)
          || key.split('/')[1].toLowerCase() !== job.user_id.toLowerCase())) throw new Error('invalid_storage_inventory');
      for (const key of new Set(keys)) await pendingImages.delete(key);
      const finished = await repository.finishAccountDeletion({ issuer: job.issuer, subject: job.subject,
        userId: job.user_id, schoolId: job.school_id, claimToken: job.claim_token });
      if (!finished?.ok) throw new Error('database_deletion_failed');
      result.completed++;
    } catch {
      // Keep the account inactive and durable job intact. The lease expires so
      // a later manual invocation can safely retry after the dependency recovers.
      result.failed++;
    }
  }
  return result;
}
