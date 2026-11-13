const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PENDING_KEY = new RegExp(`^pending/${UUID}/${UUID}\\.webp$`, 'i');

// Called by an operator or a separately reviewed free scheduler. Never scans
// arbitrary bucket keys; it only processes DB-claimed pending image uploads.
export async function cleanupPendingMedia({ repository, pendingImages, limit = 50 } = {}) {
  if (!repository || typeof repository.claimExpiredPendingImages !== 'function'
      || typeof repository.finishPendingImageCleanup !== 'function'
      || typeof pendingImages?.delete !== 'function') throw new TypeError('pending media cleanup dependencies are required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid cleanup batch size');
  const claims = await repository.claimExpiredPendingImages(limit);
  if (!Array.isArray(claims)) throw new Error('invalid cleanup claim response');
  const result = { claimed: claims.length, deleted: 0, failed: 0 };
  for (const claim of claims) {
    if (!claim || typeof claim.object_key !== 'string' || !PENDING_KEY.test(claim.object_key)
        || typeof claim.claim_token !== 'string' || !claim.claim_token) {
      if (typeof claim?.object_key === 'string' && typeof claim?.claim_token === 'string' && claim.claim_token) {
        try { await repository.finishPendingImageCleanup(claim.object_key, claim.claim_token, false); } catch { /* lease expiry permits a later retry */ }
      }
      result.failed++;
      continue;
    }
    try {
      await pendingImages.delete(claim.object_key);
      if (!await repository.finishPendingImageCleanup(claim.object_key, claim.claim_token, true)) {
        // The object is gone, but leaving the leased row allows safe DB repair
        // after the lease expires; it cannot be attached to a listing meanwhile.
        result.failed++;
      } else result.deleted++;
    } catch {
      try { await repository.finishPendingImageCleanup(claim.object_key, claim.claim_token, false); } catch { /* lease expiry permits a later retry */ }
      result.failed++;
    }
  }
  return result;
}
