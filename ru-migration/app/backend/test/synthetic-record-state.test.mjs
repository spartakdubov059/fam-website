import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifySyntheticRecordState as verify} from '../../../compat/verify-synthetic-record-state.mjs';
import {encodeSyntheticStateBackup as encode,decodeSyntheticStateBackup as decode,verifySyntheticStateAcceptance as acceptance} from '../../../compat/synthetic-state-backup-envelope.mjs';
import {encodeSyntheticFullBackup as encodeV2} from '../../../compat/synthetic-full-backup-envelope.mjs';
function fixture(){
  const a='synthetic-a',b='synthetic-b',s='synthetic-school',l='synthetic-event';
  const accounts=[{user_id:a,school_id:s,role:'council_member',active:true},{user_id:b,school_id:s,role:'student',active:true}];
  const content={profiles:accounts.map(({user_id,school_id})=>({user_id,school_id})),listings:[{id:l,user_id:a,school_id:s,image_key:'synthetic-photo'}],ideas:[{id:'synthetic-idea',user_id:b,school_id:s}],messages:[{id:'synthetic-msg',sender_id:b,receiver_id:a,school_id:s,listing_id:l}],pending_messages:[{id:'synthetic-pending',sender_id:a,receiver_id:b,school_id:s,listing_id:l}],favorites:[{user_id:b,listing_id:l}],media:[{object_key:'synthetic-photo',user_id:a}],idea_images:[]};
  const created_at='2026-11-24T12:00:00.000Z',end='2026-11-25T12:00:00.000Z';
  const payloads={listings:[{id:l,title:'synthetic:title',description:'synthetic:description',created_at}],ideas:[{id:'synthetic-idea',body:'synthetic:idea',created_at}],messages:[{id:'synthetic-msg',body:'synthetic:message',created_at}],pending_messages:[{id:'synthetic-pending',body:'synthetic:pending',created_at}]};
  const activity={listing_event_fields:[{id:l,is_event:true,event_date:'2026-11-25',event_time:'10:00',event_type:'limited',max_seats:1}],event_registrations:[{event_id:l,user_id:b,school_id:s,status:'confirmed',created_at}],event_occupancy:[{event_id:l,taken:1}],announcements:[{announcement_id:'synthetic-news',school_id:s,author_id:a,title:'synthetic:news',body:'synthetic:body',kind:'news',event_starts_at:null,published_at:created_at,expires_at:end}],polls:[{poll_id:'synthetic-poll',school_id:s,author_id:a,question:'synthetic:question',options:['synthetic:yes','synthetic:no'],created_at,closes_at:end}],votes:[{poll_id:'synthetic-poll',voter_id:b,school_id:s,choice_index:1,created_at}]};
  const source={snapshot_id:'synthetic-batch',accounts,content,objects:[{...content.media[0],byte_length:12,sha256:'a'.repeat(64)}],payloads,activity};
  const target=structuredClone(source);
  target.accounts=accounts.map((row,i)=>({...row,issuer:'https://synthetic.invalid',subject:'synthetic-identity-'+i}));
  return {source,target,restored:structuredClone(source)};
}

const digest=b=>createHash('sha256').update(b).digest('hex');
function full(){
 const f=fixture(),date='2026-11-24T13:00:00.000Z',photo=Buffer.from('synthetic:fixture');
 for(const side of ['source','target','restored']){
  f[side].objects[0].byte_length=photo.length;f[side].objects[0].sha256=digest(photo);
 }
 const m=f.source.content;
 const state={listings:[{id:m.listings[0].id,category:'Мероприятия',price_text:'Бесплатно',status:'active',photo_status:'approved'}],ideas:[{id:m.ideas[0].id,image_status:'none',ai_status:'pending',ai_summary:'',ai_reason:'synthetic:review',admin_status:'new'}],messages:[{id:m.messages[0].id,is_read:true}],favorites:[{...m.favorites[0],created_at:date}],media:[{object_key:m.media[0].object_key,status:'linked',claim_token:'',created_at:date,claim_until:date}],idea_images:[]};
 return {f,state,objects:[{object_key:m.media[0].object_key,bytes:photo}]};
}
test('v3 stores and restores read and moderation states',()=>{
 const {f,state,objects}=full();const b=encode(f.source,objects,state);
 assert.equal(b.ok,true);const r=decode(b.bytes,b.sha256);
 assert.equal(r.ok,true);assert.deepEqual(r.state,state);assert.deepEqual(r.snapshot,f.source);assert.deepEqual(r.objects,objects);
 assert.equal(acceptance({source:{snapshot:f.source,state},target:{snapshot:f.target,state},restored:{snapshot:r.snapshot,state:r.state}}).ok,true);
});
test('v2 cannot stand in for v3 state archive',()=>{
 const {f,objects}=full();const b=encodeV2(f.source,objects);assert.equal(b.ok,true);
 assert.equal(decode(b.bytes,b.sha256).code,'UNSUPPORTED_BACKUP_FORMAT');
});
test('archive without state cannot be encoded',()=>{const {f,objects}=full();assert.equal(encode(f.source,objects,undefined).code,'INVALID_RECORD_STATE');});
test('digest mismatch fails before reading state',()=>{const {f,state,objects}=full();const b=encode(f.source,objects,state);assert.equal(decode(b.bytes,'0'.repeat(64)).code,'BACKUP_DIGEST_MISMATCH');});
const cases=[
 ['read flag changed',s=>s.messages[0].is_read=false,'RECORD_STATE_MISMATCH','messages'],
 ['read flag lost',s=>delete s.messages[0].is_read,'INVALID_STATE_ROWS','messages'],
 ['listing moderation changed',s=>s.listings[0].status='pending','RECORD_STATE_MISMATCH','listings'],
 ['active photo not approved',s=>s.listings[0].photo_status='pending','INVALID_STATE_ROWS','listings'],
 ['idea review changed',s=>s.ideas[0].ai_status='approved','RECORD_STATE_MISMATCH','ideas'],
 ['invalid admin status',s=>s.ideas[0].admin_status='pending','INVALID_STATE_ROWS','ideas'],
 ['unreviewed idea marked done',s=>s.ideas[0].admin_status='done','INVALID_STATE_ROWS','ideas'],
 ['favorite timestamp changed',s=>s.favorites[0].created_at='2026-11-24T14:00:00.000Z','RECORD_STATE_MISMATCH','favorites'],
 ['active deletion lease',s=>{s.media[0].status='deleting';s.media[0].claim_token='synthetic-lease';},'INVALID_STATE_ROWS','media'],
 ['linked media marked pending',s=>s.media[0].status='pending','INVALID_STATE_ROWS','media'],
 ['unknown idea',s=>s.ideas[0].id='synthetic-unknown','INVALID_STATE_ROWS','ideas'],
 ['duplicate message state',s=>s.messages.push({...s.messages[0]}),'INVALID_STATE_ROWS','messages']
];
for(const [name,mutate,code,table] of cases)test(name,()=>{const {f,state}=full();const next=structuredClone(state);mutate(next);assert.deepEqual(verify(f.source.content,state,next),{ok:false,code,table,live_cutover_authorized:false});});
test('restored moderation mismatch fails combined acceptance',()=>{
 const {f,state}=full();const next=structuredClone(state);next.ideas[0].ai_status='approved';
 assert.deepEqual(acceptance({source:{snapshot:f.source,state},target:{snapshot:f.target,state},restored:{snapshot:f.restored,state:next}}),{ok:false,code:'RECORD_STATE_MISMATCH',table:'ideas',stage:'restored_state',live_cutover_authorized:false});
});
