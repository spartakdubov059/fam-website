import assert from 'node:assert/strict';
import {Driver} from '@ydbjs/core';
import {query} from '@ydbjs/query';
import {createYdbAgentTaskQueue} from '../app/backend/repositories/ydb-agent-task-queue.mjs';

const workerId='fam-agent-qwen-coder-v1';
const driver=new Driver('grpc://127.0.0.1:2136/local');
try{
 await driver.ready();
 const client=query(driver);
 const sql=(strings,...values)=>{const stmt=client(strings,...values);stmt.on('error',()=>{});return stmt;};
 sql.begin=client.begin.bind(client);
 const queue=createYdbAgentTaskQueue(sql);
 assert.equal((await sql`SELECT id FROM fam_agent_tasks WHERE task_type='coder_patch_request' AND status IN ('queued','claimed','in_progress') LIMIT 1;`)[0].length,0,'prior synthetic tests must release active coder tasks');
 const input={signalCode:'worker_queue_failure',eventId:'synthetic:inspector:1',occurrences:3};
 const results=await Promise.all([queue.enqueueInspectorSignal(input),queue.enqueueInspectorSignal(input)]);
 assert.equal(results.filter(r=>r.task_created).length,1);
 assert.equal(results.filter(r=>r.reason==='duplicate_event').length,1);
 const id=results.find(r=>r.task_created).task_id;
 const rows=(await sql`SELECT payload_json,max_attempts,status FROM fam_agent_tasks WHERE id=${id};`)[0];
 assert.equal(rows.length,1);assert.equal(Number(rows[0].max_attempts),2);assert.equal(rows[0].status,'queued');
 assert.deepEqual(JSON.parse(rows[0].payload_json),{task_key:'audit_agent_infrastructure',event_code:input.signalCode,page_area:'agent_infrastructure',occurrences:3});
 assert.equal((await queue.enqueueInspectorSignal({...input,eventId:'synthetic:inspector:2'})).reason,'signal_cooldown');
 assert.equal((await queue.enqueueInspectorSignal({...input,eventId:'synthetic:inspector:3',signalCode:'qwen_stuck_run'})).reason,'coder_task_already_active');
 const claim=await queue.claimSafeCoderTask({workerId,leaseSeconds:7200});
 assert.equal(claim?.id,id);
 const lease={id,workerId,claimToken:claim.claim_token};
 assert.equal(await queue.startSafeCoderTask(lease),true);
 assert.equal(await queue.heartbeatSafeCoderTask(lease),true);
 assert.equal(await queue.finishSafeCoderTask({...lease,resultCode:'model_no_patch'}),true);
 assert.equal(await queue.heartbeatSafeCoderTask(lease),false);
 assert.equal((await queue.enqueueInspectorSignal({...input,eventId:'synthetic:inspector:4'})).reason,'signal_cooldown');
 assert.equal((await sql`SELECT status FROM fam_agent_tasks WHERE id=${id};`)[0][0].status,'completed');
 assert.equal((await sql`SELECT event_id FROM fam_agent_inspector_signals WHERE task_id=${id};`)[0].length,1);
 console.log('YDB_SYNTHETIC_INSPECTOR_PASS: concurrent deduplication, cooldown, active task guard, bounded claim/start/heartbeat/finish');
}finally{await driver.close();}
