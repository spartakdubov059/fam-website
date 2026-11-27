import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { RU_MIGRATION_TABLES, prepareCompleteSyntheticBatchPlan } from './synthetic-batch-migration.mjs';
import { createSyntheticYdbBatchWriter } from './synthetic-ydb-batch-writer.mjs';
import { mapLegacyNotificationReads } from './notification-read-migration.mjs';

const sourceFixtureRows=Array.from({length:5},(_,index)=>({
  user_id:'edededed-eded-4ded-8ded-edededed0001',
  notification_key:'synthetic-batch-read-'+index,
  read_at:new Date(Date.parse('2026-11-27T12:00:00.000Z')+index*1000).toISOString(),
}));
const mapped=mapLegacyNotificationReads(sourceFixtureRows);
assert.equal(mapped.ok,true);
const mappedById=new Map(mapped.rows.map(row=>['synthetic-'+createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0,32),row]));
const fixtureRows=[...mappedById.keys()].map(id=>({id}));
const userId=mapped.rows[0].user_id;
const tableSnapshot = Object.fromEntries(RU_MIGRATION_TABLES.map(table => [table, []]));
tableSnapshot.fam_notification_reads = fixtureRows;
const plan = prepareCompleteSyntheticBatchPlan({
  snapshot_id: 'synthetic-ydb-batch-import',
  tables: tableSnapshot,
}, { batchSize: 2 });
assert.equal(plan.ok, true);
assert.equal(plan.table_count, 40);
const driver = new Driver('grpc://127.0.0.1:2136/local');
let failOnce = true;
let failPlanOnce = true;

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
    beforePlanCommit: async () => {
      if (failPlanOnce) {
        failPlanOnce = false;
        throw new Error('synthetic interruption before plan commit');
      }
    },
    beforeCheckpoint: async ({ offset }) => {
      if (offset === 2 && failOnce) {
        failOnce = false;
        throw new Error('synthetic interruption before batch checkpoint');
      }
    },
  });
  const unbound = await writer.commitBatch({
    plan, expectedPlanDigest: plan.plan_digest, table: 'fam_notification_reads', offset: 0,
    batchRows: fixtureRows.slice(0, 2), writeRows: async () => {}, verifyRows: async () => true,
  });
  assert.equal(unbound.code, 'PLAN_NOT_BOUND', 'target rows cannot be written before the run manifest is committed');
  await assert.rejects(
    () => writer.initializePlan({ plan, expectedPlanDigest: plan.plan_digest }),
    error => error?.cause?.message === 'synthetic interruption before plan commit',
  );
  assert.equal((await sql`SELECT snapshot_id FROM fam_migration_rehearsal_plans
    WHERE snapshot_id = ${plan.snapshot_id};`)[0].length, 0, 'interrupted manifest header rolls back');
  assert.equal((await sql`SELECT table_name FROM fam_migration_rehearsal_plan_tables
    WHERE snapshot_id = ${plan.snapshot_id};`)[0].length, 0, 'interrupted table manifest rolls back');
  assert.equal((await writer.initializePlan({ plan, expectedPlanDigest: plan.plan_digest })).code, 'SYNTHETIC_PLAN_BOUND');
  assert.equal((await writer.initializePlan({ plan, expectedPlanDigest: plan.plan_digest })).code, 'SYNTHETIC_PLAN_REPLAY_VERIFIED');
  const boundTables = (await sql`SELECT table_name, row_count, batch_count, plan_digest
    FROM fam_migration_rehearsal_plan_tables WHERE snapshot_id = ${plan.snapshot_id} ORDER BY table_name;`)[0];
  assert.equal(boundTables.length, 40, 'the manifest explicitly binds every classified target table');
  assert.deepEqual(boundTables.map(row => [row.table_name, Number(row.row_count), Number(row.batch_count)]),
    [...RU_MIGRATION_TABLES].sort().map(table => [table,
      table === 'fam_notification_reads' ? fixtureRows.length : 0,
      table === 'fam_notification_reads' ? plan.batch_count : 0]),
    'the manifest explicitly binds empty and non-empty tables');
  assert.ok(boundTables.every(row => row.plan_digest === plan.plan_digest));
  const substitutedPlan = prepareCompleteSyntheticBatchPlan({
    snapshot_id: plan.snapshot_id,
    tables: { ...tableSnapshot, fam_favorites: [{ id: 'synthetic-changed-row' }] },
  }, { batchSize: 2 });
  assert.equal((await writer.initializePlan({ plan: substitutedPlan, expectedPlanDigest: substitutedPlan.plan_digest })).code,
    'STORED_PLAN_MISMATCH', 'the same snapshot id cannot be rebound to a changed plan');
  const writeRows = async (tx, batchRows) => {
    for (const row of batchRows) {
      const mappedRow=mappedById.get(row.id);
      assert.ok(mappedRow,'every planner digest must resolve to its mapped synthetic source row');
      await tx`INSERT INTO fam_notification_reads (user_id, notification_key, read_at)
        VALUES (${mappedRow.user_id}, ${mappedRow.notification_key}, ${mappedRow.read_at});`;
    }
  };
  const verifyRows = async (tx, batchRows) => {
    for (const row of batchRows) {
      const mappedRow=mappedById.get(row.id);
      const found = await tx`SELECT read_at FROM fam_notification_reads
        WHERE user_id = ${mappedRow.user_id} AND notification_key = ${mappedRow.notification_key};`;
      if (found[0].length !== 1 || new Date(found[0][0].read_at).getTime() !== mappedRow.read_at.getTime()) return false;
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
  await sql`DELETE FROM fam_migration_rehearsal_plan_tables
    WHERE snapshot_id = ${plan.snapshot_id} AND table_name = 'fam_favorites';`;
  assert.equal((await commit(chunks[1])).code, 'PLAN_TABLES_NOT_BOUND',
    'a damaged full-table manifest blocks later batch writes');
  const rowsAfterManifestFailure = (await sql`SELECT notification_key FROM fam_notification_reads
    WHERE user_id = ${userId} ORDER BY notification_key;`)[0];
  assert.deepEqual(rowsAfterManifestFailure.map(row => row.notification_key).sort(),
    chunks[0].rows.map(row => row.id).sort(), 'manifest refusal leaves target rows unchanged');
  await sql`INSERT INTO fam_migration_rehearsal_plan_tables
    (snapshot_id, table_name, row_count, batch_count, plan_digest, created_at)
    VALUES (${plan.snapshot_id}, 'fam_favorites', Unwrap(CAST(0 AS Uint32)),
      Unwrap(CAST(0 AS Uint32)), ${plan.plan_digest}, CurrentUtcTimestamp());`;
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
  await sql`DELETE FROM fam_migration_rehearsal_plan_tables
    WHERE snapshot_id = ${plan.snapshot_id} AND table_name = 'fam_favorites';`;
  assert.equal((await writer.initializePlan({ plan, expectedPlanDigest: plan.plan_digest })).code,
    'STORED_PLAN_TABLES_MISMATCH', 'a partially missing table manifest must fail closed on resume');
  console.log('YDB_SYNTHETIC_BATCH_IMPORT_PASS: target rows and checkpoints commit atomically, interruption resumes, exact replay verifies');

  await sql.begin(async tx => {
    await tx`DELETE FROM fam_notification_reads WHERE user_id = ${userId};`;
    await tx`DELETE FROM fam_migration_rehearsal_batches WHERE snapshot_id = ${plan.snapshot_id};`;
    await tx`DELETE FROM fam_migration_rehearsal_plan_tables WHERE snapshot_id = ${plan.snapshot_id};`;
    await tx`DELETE FROM fam_migration_rehearsal_plans WHERE snapshot_id = ${plan.snapshot_id};`;
  });
} finally {
  await driver.close();
}
