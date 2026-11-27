import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { prepareSyntheticBatchPlan } from './synthetic-batch-migration.mjs';
import { createSyntheticYdbBatchWriter } from './synthetic-ydb-batch-writer.mjs';

const userId = 'synthetic-batch-import-user';
const createdAt = new Date('2026-11-27T12:00:00.000Z');
const fixtureRows = Array.from({ length: 5 }, (_, index) => ({ id: 'synthetic-batch-read-' + index }));
const plan = prepareSyntheticBatchPlan({
  snapshot_id: 'synthetic-ydb-batch-import',
  tables: { fam_notification_reads: fixtureRows },
}, { batchSize: 2 });
assert.equal(plan.ok, true);
const driver = new Driver('grpc://127.0.0.1:2136/local');
let failOnce = true;

try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => {
    const statement = client(strings, ...values);
    statement.on('error', () => {});
    return statement;
  };
  sql.begin = client.begin.bind(client);

  const writer = createSyntheticYdbBatchWriter({
    sql,
    beforeCheckpoint: async ({ offset }) => {
      if (offset === 2 && failOnce) {
        failOnce = false;
        throw new Error('synthetic interruption before batch checkpoint');
      }
    },
  });
  const writeRows = async (tx, batchRows) => {
    for (const row of batchRows) {
      await tx`INSERT INTO fam_notification_reads (user_id, notification_key, read_at)
        VALUES (${userId}, ${row.id}, ${createdAt});`;
    }
  };
  const verifyRows = async (tx, batchRows) => {
    for (const row of batchRows) {
      const found = await tx`SELECT read_at FROM fam_notification_reads
        WHERE user_id = ${userId} AND notification_key = ${row.id};`;
      if (found[0].length !== 1 || new Date(found[0][0].read_at).getTime() !== createdAt.getTime()) return false;
    }
    return true;
  };
  const chunks = [
    { offset: 0, rows: fixtureRows.slice(0, 2) },
    { offset: 2, rows: fixtureRows.slice(2, 4) },
    { offset: 4, rows: fixtureRows.slice(4) },
  ];
  const commit = chunk => writer.commitBatch({
    plan,
    expectedPlanDigest: plan.plan_digest,
    table: 'fam_notification_reads',
    offset: chunk.offset,
    batchRows: chunk.rows,
    writeRows,
    verifyRows,
  });

  assert.equal((await commit(chunks[0])).code, 'SYNTHETIC_BATCH_COMMITTED');
  await assert.rejects(
    () => commit(chunks[1]),
    error => error?.cause?.message === 'synthetic interruption before batch checkpoint',
  );
  const failedRows = (await sql`SELECT notification_key FROM fam_notification_reads
    WHERE user_id = ${userId} ORDER BY notification_key;`)[0];
  assert.deepEqual(failedRows.map(row => row.notification_key).sort(), chunks[0].rows.map(row => row.id).sort());
  const receiptAfterInterruption = (await sql`SELECT batch_offset FROM fam_migration_rehearsal_batches
    WHERE snapshot_id = ${plan.snapshot_id} ORDER BY batch_offset;`)[0];
  assert.deepEqual(receiptAfterInterruption.map(row => Number(row.batch_offset)), [0]);

  assert.equal((await commit(chunks[1])).code, 'SYNTHETIC_BATCH_COMMITTED');
  assert.equal((await commit(chunks[2])).code, 'SYNTHETIC_BATCH_COMMITTED');
  assert.equal((await commit(chunks[0])).code, 'SYNTHETIC_BATCH_REPLAY_VERIFIED');
  assert.equal((await commit(chunks[1])).code, 'SYNTHETIC_BATCH_REPLAY_VERIFIED');

  const finalRows = (await sql`SELECT notification_key FROM fam_notification_reads
    WHERE user_id = ${userId} ORDER BY notification_key;`)[0];
  assert.deepEqual(finalRows.map(row => row.notification_key).sort(), fixtureRows.map(row => row.id).sort());
  console.log('YDB_SYNTHETIC_BATCH_IMPORT_PASS: target rows and checkpoints commit atomically, interruption resumes, exact replay verifies');

  await sql.begin(async tx => {
    await tx`DELETE FROM fam_notification_reads WHERE user_id = ${userId};`;
    await tx`DELETE FROM fam_migration_rehearsal_batches WHERE snapshot_id = ${plan.snapshot_id};`;
  });
} finally {
  await driver.close();
}
