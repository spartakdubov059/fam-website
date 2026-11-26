import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RU_MIGRATION_TABLES,
  prepareSyntheticBatchPlan,
  verifySyntheticBatchRecovery,
} from './synthetic-batch-migration.mjs';

test('batch migration covers the RU table catalog and creates bounded chunks', () => {
  assert.equal(RU_MIGRATION_TABLES.length, 40);
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: `synthetic-row-${index}` }));
  const plan = prepareSyntheticBatchPlan({
    snapshot_id: 'synthetic-batch-1',
    tables: { fam_listings: rows, fam_notification_reads: [] },
  }, { batchSize: 100 });
  assert.equal(plan.ok, true);
  assert.equal(plan.table_count, 2);
  assert.equal(plan.batch_count, 3);
  assert.deepEqual(plan.batches.map(batch => batch.count), [100, 100, 5]);
  assert.match(plan.plan_digest, /^[a-f0-9]{64}$/);
  assert.equal(plan.live_cutover_authorized, false);
});

test('batch recovery refuses tampered chunks and resumes only missing work', () => {
  const plan = prepareSyntheticBatchPlan({
    snapshot_id: 'synthetic-batch-2',
    tables: { fam_messages: Array.from({ length: 101 }, (_, index) => ({ id: `synthetic-${index}` })) },
  }, { batchSize: 100 });
  const recovered = verifySyntheticBatchRecovery(plan, [plan.batches[0]], 0);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.completed, 1);
  assert.equal(recovered.remaining.length, 1);
  assert.equal(recovered.remaining[0].offset, 100);
  assert.equal(verifySyntheticBatchRecovery(plan, [{ table: 'fam_messages', offset: 0, digest: 'f'.repeat(64) }], 0).code,
    'BATCH_DIGEST_MISMATCH');
});

test('batch migration rejects unknown tables and oversized row batches', () => {
  assert.equal(prepareSyntheticBatchPlan({
    snapshot_id: 'synthetic-batch-3',
    tables: { unknown_table: [] },
  }).code, 'UNSUPPORTED_MIGRATION_TABLE');
  assert.equal(prepareSyntheticBatchPlan({
    snapshot_id: 'synthetic-batch-4',
    tables: { fam_listings: [] },
  }, { batchSize: 501 }).code, 'INVALID_BATCH_SIZE');
});
