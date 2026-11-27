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
export function createSyntheticYdbBatchWriter({
  sql,
  beforeCheckpoint = async () => {},
  beforePlanCommit = async () => {},
} = {}) {
  if (typeof sql !== 'function' || typeof sql.begin !== 'function'
      || typeof beforeCheckpoint !== 'function' || typeof beforePlanCommit !== 'function') {
    throw new TypeError('transactional YDB query client and checkpoint hook are required');
  }

  return Object.freeze({
    async initializePlan({ plan, expectedPlanDigest } = {}) {
      if (!verifySyntheticBatchRecovery(plan, [], -1, expectedPlanDigest).ok) return fail('INVALID_BATCH_PLAN');
      return sql.begin(async tx => {
        const planRows = rows(await tx`SELECT plan_digest, table_count, batch_count
          FROM fam_migration_rehearsal_plans WHERE snapshot_id = ${plan.snapshot_id};`);
        const tableRows = rows(await tx`SELECT table_name, row_count, batch_count, plan_digest
          FROM fam_migration_rehearsal_plan_tables WHERE snapshot_id = ${plan.snapshot_id};`);
        if (planRows.length > 1 || tableRows.length > plan.table_count) return fail('INVALID_STORED_PLAN');
        if (planRows.length && (planRows[0].plan_digest !== expectedPlanDigest
            || Number(planRows[0].table_count) !== plan.table_count
            || Number(planRows[0].batch_count) !== plan.batch_count)) return fail('STORED_PLAN_MISMATCH');

        const expectedTables = plan.table_counts.map(item => ({
          table: item.table,
          count: item.count,
          batches: plan.batches.filter(batch => batch.table === item.table).length,
        }));
        const storedTables = new Map();
        for (const item of tableRows) {
          if (storedTables.has(item.table_name)) return fail('DUPLICATE_STORED_PLAN_TABLE');
          storedTables.set(item.table_name, {
            count: Number(item.row_count),
            batches: Number(item.batch_count),
            digest: item.plan_digest,
          });
        }
        if (storedTables.size && (storedTables.size !== expectedTables.length
            || expectedTables.some(item => {
              const stored = storedTables.get(item.table);
              return !stored || stored.count !== item.count || stored.batches !== item.batches
                || stored.digest !== expectedPlanDigest;
            }))) return fail('STORED_PLAN_TABLES_MISMATCH');
        if (!planRows.length && storedTables.size) return fail('ORPHANED_STORED_PLAN_TABLES');

        if (!planRows.length) {
          await tx`INSERT INTO fam_migration_rehearsal_plans
            (snapshot_id, plan_digest, table_count, batch_count, created_at)
            VALUES (${plan.snapshot_id}, ${expectedPlanDigest}, Unwrap(CAST(${plan.table_count} AS Uint32)),
              Unwrap(CAST(${plan.batch_count} AS Uint32)), CurrentUtcTimestamp());`;
          for (const item of expectedTables) {
            await tx`INSERT INTO fam_migration_rehearsal_plan_tables
              (snapshot_id, table_name, row_count, batch_count, plan_digest, created_at)
              VALUES (${plan.snapshot_id}, ${item.table}, Unwrap(CAST(${item.count} AS Uint32)),
                Unwrap(CAST(${item.batches} AS Uint32)), ${expectedPlanDigest}, CurrentUtcTimestamp());`;
          }
          await beforePlanCommit({ snapshotId: plan.snapshot_id, plan });
          return { ok: true, code: 'SYNTHETIC_PLAN_BOUND', table_count: plan.table_count, live_cutover_authorized: false };
        }
        if (!tableRows.length && expectedTables.length) return fail('MISSING_STORED_PLAN_TABLES');
        return { ok: true, code: 'SYNTHETIC_PLAN_REPLAY_VERIFIED', table_count: plan.table_count, live_cutover_authorized: false };
      });
    },
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
        const boundPlan = rows(await tx`SELECT plan_digest, table_count, batch_count
          FROM fam_migration_rehearsal_plans WHERE snapshot_id = ${plan.snapshot_id};`);
        if (boundPlan.length !== 1 || boundPlan[0].plan_digest !== expectedPlanDigest
            || Number(boundPlan[0].table_count) !== plan.table_count
            || Number(boundPlan[0].batch_count) !== plan.batch_count) return fail('PLAN_NOT_BOUND');
        const boundTables = rows(await tx`SELECT table_name, row_count, batch_count, plan_digest
          FROM fam_migration_rehearsal_plan_tables WHERE snapshot_id = ${plan.snapshot_id};`);
        if (boundTables.length !== plan.table_count) return fail('PLAN_TABLES_NOT_BOUND');
        const boundByName = new Map(boundTables.map(row => [row.table_name, row]));
        for (const item of plan.table_counts) {
          const storedTable = boundByName.get(item.table);
          const expectedBatches = plan.batches.filter(batch => batch.table === item.table).length;
          if (!storedTable || Number(storedTable.row_count) !== item.count
              || Number(storedTable.batch_count) !== expectedBatches
              || storedTable.plan_digest !== expectedPlanDigest) return fail('PLAN_TABLES_NOT_BOUND');
        }
        if (boundByName.size !== plan.table_count) return fail('PLAN_TABLES_NOT_BOUND');
        const expectedTable = plan.table_counts.find(item => item.table === table);
        if (!expectedTable || !boundByName.has(table)) return fail('PLAN_TABLE_NOT_BOUND');

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
