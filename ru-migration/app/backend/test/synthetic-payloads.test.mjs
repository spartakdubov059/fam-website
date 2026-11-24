import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySyntheticPayloads as verify } from '../../../compat/verify-synthetic-payloads.mjs';
function fixture(){
 const a='synthetic-a',b='synthetic-b',s='synthetic-school',l='synthetic-listing';
 const metadata={profiles:[{user_id:a,school_id:s},{user_id:b,school_id:s}],listings:[{id:l,user_id:a,school_id:s,image_key:''}],ideas:[{id:'synthetic-idea',user_id:a,school_id:s}],messages:[{id:'synthetic-msg',sender_id:b,receiver_id:a,school_id:s,listing_id:l}],pending_messages:[{id:'synthetic-pending',sender_id:a,receiver_id:b,school_id:s,listing_id:l}],favorites:[],media:[],idea_images:[]};
 const created_at='2026-11-24T12:00:00.000Z';
 const source={listings:[{id:l,title:'synthetic:title',description:'synthetic:description',created_at}],ideas:[{id:'synthetic-idea',body:'synthetic:idea',created_at}],messages:[{id:'synthetic-msg',body:'synthetic:message',created_at}],pending_messages:[{id:'synthetic-pending',body:'synthetic:pending',created_at}]};
 return {metadata,source,target:structuredClone(source)};
}
test('equal synthetic payloads pass without authorizing cutover',()=>{const f=fixture();assert.deepEqual(verify(f.metadata,f.source,f.target),{ok:true,code:'SYNTHETIC_PAYLOADS_MATCH',live_cutover_authorized:false});});
for(const table of ['listings','ideas','messages','pending_messages']){
 test('detects changed payload in '+table,()=>{const f=fixture();f.target[table][0][table==='listings'?'description':'body']='synthetic:changed';assert.deepEqual(verify(f.metadata,f.source,f.target),{ok:false,code:'PAYLOAD_MISMATCH',table});});
}
test('detects changed timestamp',()=>{const f=fixture();f.target.messages[0].created_at='2026-11-24T12:00:01.000Z';assert.equal(verify(f.metadata,f.source,f.target).code,'PAYLOAD_MISMATCH');});
test('rejects missing payload on both sides',()=>{const f=fixture();f.source.messages=[];f.target.messages=[];assert.equal(verify(f.metadata,f.source,f.target).code,'INVALID_PAYLOAD_ROWS');});
test('rejects unknown or duplicate IDs',()=>{const f=fixture();f.target.messages[0].id='synthetic-unknown';assert.equal(verify(f.metadata,f.source,f.target).code,'INVALID_PAYLOAD_ROWS');f.target.messages.push(f.target.messages[0]);assert.equal(verify(f.metadata,f.source,f.target).code,'INVALID_PAYLOAD_ROWS');});
test('rejects non-synthetic text and invalid timestamp',()=>{const f=fixture();f.target.messages[0].body='not synthetic';assert.equal(verify(f.metadata,f.source,f.target).code,'INVALID_PAYLOAD_ROWS');f.target=structuredClone(f.source);f.target.messages[0].created_at='2026-11-24T25:00:00.000Z';assert.equal(verify(f.metadata,f.source,f.target).code,'INVALID_PAYLOAD_ROWS');});
