import { createHash } from 'node:crypto';
import { verifySyntheticBatchRecovery } from './synthetic-batch-migration.mjs';

const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = code => ({ ok: false, code, live_cutover_authorized: false });
const hash = value => createHash('sha256').update(value).digest('hex');
const keyOf = batch => JSON.stringify([batch.table, batch.offset]);

function rows(result) {
  if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error('invalid batch receipt query result');
  return result[0];
}

// Synthetic YDB rehearsal writer. Domain row mapping stays explicit in each caller;
// receipts and target rows commit together in one serializable transaction.
export function createSyntheticYdbBatchWriter({ sql, beforeCheckpoint = async () => {} } = {}) {
  if (typeof sql !== 'function' || typeof sql.begin !== 'function' || typeof beforeCheckpoint !== 'function') {
    throw new TypeError('transactional YDB query client and checkpoint hook are required');
  }

  return Object.freeze({
    async commitBatch({ plan, expectedPlanDigest, table, offset, batchRows, writeRows, verifyRows } = {}) {
      if (!verifySyntheticBatchRecovery(plan, [], -1, expectedPlanDigest).ok
          || typeof table !== 'string' || !Number.isSafeInteger(offset) || offset < 0
          || !Array.isArray(batchRows) || typeof writeRows !== 'function' || typeof verifyRows !== 'function') {
        return fail('INVALID_BATCH_INPUT');
      }
      const batchIndex = plan.batches.findIndex(batch => batch.table === table && batch.offset === offset);
      if (batchIndex < 0) return fail('UNPLANNED_BATCH');
      const batch = plan.batches[batchIndex];
      if (batchRows.length !== batch.count || batchRows.some(row =>
        !exact(row, ['id']) || typeof row.id !== 'string' || !/^synthetic-[a-z0-9-]{1,100}$/.test(row.id))
        || new Set(batchRows.map(row => row.id)).size !== batchRows.length
        || hash(JSON.stringify(batchRows)) !== batch.digest) return fail('BATCH_DIGEST_MISMATCH');

      return sql.begin(async tx => {
        const stored = rows(await tx`SELECT table_name, batch_offset, row_count, batch_digest
          FROM fam_migration_rehearsal_batches WHERE snapshot_id = ${plan.snapshot_id};`);
        const receiptMap = new Map();
        for (const receipt of stored) {
          const normalized = {
            table: receipt.table_name,
            offset: Number(receipt.batch_offset),
            count: Number(receipt.row_count),
            digest: receipt.batch_digest,
          };
          const key = keyOf(normalized);
          if (!Number.isSafeInteger(normalized.offset) || !Number.isSafeInteger(normalized.count)
              || receiptMap.has(key)) return fail('INVALID_STORED_CHECKPOINT');
          receiptMap.set(key, normalized);
        }

        const committed = [];
        for (const expected of plan.batches) {
          const key = keyOf(expected);
          const receipt = receiptMap.get(key);
          if (!receipt) break;
          if (receipt.count !== expected.count || receipt.digest !== expected.digest) {
            return fail('STORED_CHECKPOINT_MISMATCH');
          }
          committed.push(receipt);
        }
        if (committed.length !== receiptMap.size
            || !verifySyntheticBatchRecovery(plan, committed, committed.length - 1, expectedPlanDigest).ok) {
          return fail('NONCONTIGUOUS_STORED_CHECKPOINT');
        }

        if (batchIndex < committed.length) {
          if (batchIndex !== committed.findIndex(item => item.table === table && item.offset === offset)
              || !await verifyRows(tx, batchRows)) return fail('COMMITTED_BATCH_TARGET_MISMATCH');
          return { ok: true, code: 'SYNTHETIC_BATCH_REPLAY_VERIFIED', table, offset, live_cutover_authorized: false };
        }
        if (batchIndex !== committed.length) return fail('BATCH_ORDER_MISMATCH');

        await writeRows(tx, batchRows);
        if (!await verifyRows(tx, batchRows)) throw new Error('synthetic target rows failed verification');
        await beforeCheckpoint({ snapshotId: plan.snapshot_id, table, offset, batch });
        await tx`INSERT INTO fam_migration_rehearsal_batches
          (snapshot_id, table_name, batch_offset, row_count, batch_digest, committed_at)
          VALUES (${plan.snapshot_id}, ${table}, Unwrap(CAST(${offset} AS Uint32)),
            Unwrap(CAST(${batch.count} AS Uint32)), ${batch.digest}, CurrentUtcTimestamp());`;
        return { ok: true, code: 'SYNTHETIC_BATCH_COMMITTED', table, offset, live_cutover_authorized: false };
      });
    },
  });
}
