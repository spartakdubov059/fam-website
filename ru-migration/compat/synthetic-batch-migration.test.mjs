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
  const recovered = verifySyntheticBatchRecovery(plan, [plan.batches[0]], 0, plan.plan_digest);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.completed, 1);
  assert.equal(recovered.remaining.length, 1);
  assert.equal(recovered.remaining[0].offset, 100);
  assert.equal(verifySyntheticBatchRecovery(plan, [{ table: 'fam_messages', offset: 0, count: 100, digest: 'f'.repeat(64) }], 0, plan.plan_digest).code,
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

const checkpointFixture=()=>prepareSyntheticBatchPlan({snapshot_id:'synthetic-checkpoint',tables:{fam_listings:[{id:'synthetic-a'},{id:'synthetic-b'}],fam_messages:[]}}, {batchSize:1});
test('checkpoint rejects duplicate, skipped, malformed and unbound receipts',()=>{
 const p=checkpointFixture(),d=p.plan_digest;
 assert.equal(verifySyntheticBatchRecovery(p,[p.batches[0],p.batches[0]],1,d).code,'DUPLICATE_COMPLETED_BATCH');
 assert.equal(verifySyntheticBatchRecovery(p,[p.batches[1]],0,d).code,'NONCONTIGUOUS_BATCH_CHECKPOINT');
 assert.equal(verifySyntheticBatchRecovery(p,[p.batches[0]],1,d).code,'NONCONTIGUOUS_BATCH_CHECKPOINT');
 assert.equal(verifySyntheticBatchRecovery(p,[], -1).code,'INVALID_BATCH_RECOVERY');
 assert.equal(verifySyntheticBatchRecovery(p,[], -1,'f'.repeat(64)).code,'INVALID_BATCH_RECOVERY');
 const changed=structuredClone(p);changed.batches[0].digest='f'.repeat(64);
 assert.equal(verifySyntheticBatchRecovery(changed,[],-1,d).code,'INVALID_BATCH_RECOVERY');
 assert.equal(verifySyntheticBatchRecovery({...p,batches:null},[],-1,d).code,'INVALID_BATCH_RECOVERY');
 assert.equal(verifySyntheticBatchRecovery(p,[{...p.batches[0],count:2}],0,d).code,'BATCH_DIGEST_MISMATCH');
});
test('empty tables are explicitly bound and cannot be replaced silently',()=>{
 const p=checkpointFixture(),changed=structuredClone(p);
 changed.table_counts[1].table='fam_ideas';
 assert.equal(verifySyntheticBatchRecovery(changed,[],-1,p.plan_digest).ok,false);
 assert.deepEqual(p.table_counts,[{table:'fam_listings',count:2},{table:'fam_messages',count:0}]);
});
test('planner rejects real-looking rows, arbitrary fields, duplicate IDs and global overflow',()=>{
 const plan=rows=>prepareSyntheticBatchPlan({snapshot_id:'synthetic-rows',tables:{fam_messages:rows}});
 for(const rows of [[{id:'actual-user'}],[{id:'synthetic-a',body:'synthetic:unapproved'}],[{id:'synthetic-a'},{id:'synthetic-a'}],[null]])assert.equal(plan(rows).code,'INVALID_SYNTHETIC_BATCH_ROW');
 const rows=Array.from({length:6000},(_,i)=>({id:'synthetic-'+i}));
 assert.equal(prepareSyntheticBatchPlan({snapshot_id:'synthetic-overflow',tables:{fam_listings:rows,fam_messages:rows}}).code,'SYNTHETIC_BATCH_TOO_LARGE');
});
