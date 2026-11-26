import { createHash } from 'node:crypto';

export const RU_MIGRATION_TABLES = Object.freeze([
  'fam_account_deletion_jobs',
  'fam_account_deletion_open',
  'fam_account_deletion_requests',
  'fam_account_suspension_audit',
  'fam_account_suspension_open',
  'fam_account_suspensions',
  'fam_agent_daily_digest_tasks',
  'fam_agent_daily_reports',
  'fam_agent_ideas',
  'fam_agent_inspector_signals',
  'fam_agent_school_daily_reports',
  'fam_agent_task_events',
  'fam_agent_tasks',
  'fam_avatar_reviews',
  'fam_event_occupancy',
  'fam_event_registrations',
  'fam_favorites',
  'fam_idea_images',
  'fam_ideas',
  'fam_initial_school_admin_bootstrap',
  'fam_listings',
  'fam_messages',
  'fam_notification_reads',
  'fam_pending_media',
  'fam_pending_messages',
  'fam_profile_requests',
  'fam_role_email_verifications',
  'fam_safety_incidents',
  'fam_school_admin_audit',
  'fam_school_announcements',
  'fam_school_content_audit',
  'fam_school_poll_votes',
  'fam_school_polls',
  'fam_school_role_request_audit',
  'fam_school_role_requests',
  'fam_site_error_counts',
  'fam_site_error_digest_tasks',
  'fam_step_up_email_challenges',
  'fam_submission_quotas',
  'fam_user_profiles',
]);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// A bounded synthetic checkpoint planner, NOT a database row exporter/importer.
const MAX_ROWS=10000;
const MAX_BYTES=4*1024*1024;
const idPattern=/^synthetic-[a-z0-9-]{1,100}$/;
const snapshotPattern=/^synthetic-[a-z0-9-]{3,64}$/i;
const digestPattern=/^[a-f0-9]{64}$/;
const digest=x=>typeof x==='string'&&digestPattern.test(x);
const fail=code=>({ok:false,code,live_cutover_authorized:false});
const canonical=p=>JSON.stringify({snapshot_id:p.snapshot_id,batch_size:p.batch_size,table_counts:p.table_counts,batches:p.batches});

export function prepareSyntheticBatchPlan(snapshot,{batchSize=100}={}) {
  if(!exact(snapshot,['snapshot_id','tables'])||typeof snapshot.snapshot_id!=='string'||!snapshotPattern.test(snapshot.snapshot_id)||!snapshot.tables||typeof snapshot.tables!=='object'||Array.isArray(snapshot.tables))return fail('INVALID_SYNTHETIC_BATCH');
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>500)return fail('INVALID_BATCH_SIZE');
  const names=Object.keys(snapshot.tables).sort();
  if(!names.length||names.some(name=>!RU_MIGRATION_TABLES.includes(name)||!Array.isArray(snapshot.tables[name])||snapshot.tables[name].length>MAX_ROWS))return fail('UNSUPPORTED_MIGRATION_TABLE');
  let total=0,bytes=0;
  const batches=[],table_counts=[];
  for(const table of names){
    const rows=snapshot.tables[table],ids=new Set();
    total+=rows.length;
    if(total>MAX_ROWS)return fail('SYNTHETIC_BATCH_TOO_LARGE');
    for(const row of rows){
      // Placeholder IDs only: no real profile, auth token, message or arbitrary DB payload.
      if(!exact(row,['id'])||typeof row.id!=='string'||!idPattern.test(row.id)||ids.has(row.id))return fail('INVALID_SYNTHETIC_BATCH_ROW');
      ids.add(row.id);bytes+=Buffer.byteLength(row.id);
      if(bytes>MAX_BYTES)return fail('SYNTHETIC_BATCH_TOO_LARGE');
    }
    table_counts.push(Object.freeze({table,count:rows.length}));
    for(let offset=0;offset<rows.length;offset+=batchSize){
      const chunk=rows.slice(offset,offset+batchSize);
      batches.push(Object.freeze({table,offset,count:chunk.length,digest:hash(JSON.stringify(chunk))}));
    }
  }
  const plan={ok:true,code:'SYNTHETIC_BATCH_PLAN_READY',snapshot_id:snapshot.snapshot_id,batch_size:batchSize,table_count:names.length,table_counts:Object.freeze(table_counts),batch_count:batches.length,batches:Object.freeze(batches),live_cutover_authorized:false};
  return Object.freeze({...plan,plan_digest:hash(canonical(plan))});
}

function validPlan(plan,expectedPlanDigest){
  if(!exact(plan,['ok','code','snapshot_id','batch_size','table_count','table_counts','batch_count','batches','live_cutover_authorized','plan_digest'])||plan.ok!==true||plan.code!=='SYNTHETIC_BATCH_PLAN_READY'||plan.live_cutover_authorized!==false||typeof plan.snapshot_id!=='string'||!snapshotPattern.test(plan.snapshot_id)||!Number.isSafeInteger(plan.batch_size)||plan.batch_size<1||plan.batch_size>500||!Array.isArray(plan.table_counts)||plan.table_counts.length!==plan.table_count||plan.table_count<1||plan.table_count>RU_MIGRATION_TABLES.length||!Array.isArray(plan.batches)||plan.batches.length!==plan.batch_count||plan.batch_count>MAX_ROWS||!digest(plan.plan_digest)||!digest(expectedPlanDigest)||plan.plan_digest!==expectedPlanDigest)return false;
  let cursor=0,total=0,previous='';
  for(const row of plan.table_counts){
    if(!exact(row,['table','count'])||!RU_MIGRATION_TABLES.includes(row.table)||row.table<=previous||!Number.isSafeInteger(row.count)||row.count<0||row.count>MAX_ROWS)return false;
    previous=row.table;total+=row.count;if(total>MAX_ROWS)return false;
    for(let offset=0;offset<row.count;offset+=plan.batch_size){
      const batch=plan.batches[cursor++];
      if(!exact(batch,['table','offset','count','digest'])||batch.table!==row.table||batch.offset!==offset||batch.count!==Math.min(plan.batch_size,row.count-offset)||!digest(batch.digest))return false;
    }
  }
  return cursor===plan.batch_count&&hash(canonical(plan))===expectedPlanDigest;
}

// Expected digest must be retained independently at preparation time. A digest is
// not authentication, and matching receipts are not proof of committed DB writes.
export function verifySyntheticBatchRecovery(plan,completedBatches,interruptedIndex,expectedPlanDigest){
  if(!validPlan(plan,expectedPlanDigest)||!Array.isArray(completedBatches)||completedBatches.length>plan.batch_count||!Number.isSafeInteger(interruptedIndex)||interruptedIndex< -1||interruptedIndex>=plan.batch_count)return fail('INVALID_BATCH_RECOVERY');
  const expected=new Map(plan.batches.map(b=>[`${b.table}:${b.offset}`,b]));
  const completed=new Set();
  for(const item of completedBatches){
    if(!exact(item,['table','offset','count','digest'])||typeof item.table!=='string'||!Number.isSafeInteger(item.offset)||!Number.isSafeInteger(item.count)||!digest(item.digest))return fail('INVALID_COMPLETED_BATCH');
    const key=`${item.table}:${item.offset}`,batch=expected.get(key);
    if(!batch||batch.digest!==item.digest||batch.count!==item.count)return fail('BATCH_DIGEST_MISMATCH');
    if(completed.has(key))return fail('DUPLICATE_COMPLETED_BATCH');
    completed.add(key);
  }
  // Only a contiguous committed prefix is supported by this sequential rehearsal.
  if(completed.size!==interruptedIndex+1||plan.batches.some((b,i)=>completed.has(`${b.table}:${b.offset}`)!==(i<=interruptedIndex)))return fail('NONCONTIGUOUS_BATCH_CHECKPOINT');
  const remaining=plan.batches.slice(completed.size).map(({table,offset,digest})=>({table,offset,digest}));
  return {ok:true,code:'SYNTHETIC_BATCH_RECOVERY_READY',interrupted_index:interruptedIndex,completed:completed.size,remaining,live_cutover_authorized:false};
}
