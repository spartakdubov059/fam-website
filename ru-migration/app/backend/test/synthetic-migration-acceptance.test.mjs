import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifySyntheticMigrationAcceptance as verify} from '../../../compat/verify-synthetic-migration-acceptance.mjs';
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
test('complete three-way acceptance passes without granting production approval',()=>{const result=verify(fixture());assert.equal(result.ok,true);assert.equal(result.accounts,2);assert.equal(result.attachments,1);assert.equal(result.activity_counts.votes,1);assert.equal(result.content_counts.pending_messages,1);assert.equal(result.live_cutover_authorized,false);});
const cases=[
["missing payload section",f=>delete f.target.payloads,"input","INVALID_COMPLETE_SNAPSHOT"],
["missing activity section",f=>delete f.restored.activity,"input","INVALID_COMPLETE_SNAPSHOT"],
["different snapshot ID",f=>f.restored.snapshot_id="synthetic-old","input","SNAPSHOT_ID_MISMATCH"],
["target role change",f=>f.target.accounts[1].role="school_admin","target_data","PROFILE_INVARIANT_CHANGED"],
["target photo corruption",f=>f.target.objects[0].sha256="b".repeat(64),"target_attachments","ATTACHMENT_BYTES_MISMATCH"],
["restore photo corruption",f=>f.restored.objects[0].sha256="b".repeat(64),"restored_attachments","ATTACHMENT_BYTES_MISMATCH"],
["target changed message text",f=>f.target.payloads.messages[0].body="synthetic:changed","target_payloads","PAYLOAD_MISMATCH","messages"],
["restored missing pending message payload",f=>f.restored.payloads.pending_messages=[],"restored_payloads","INVALID_PAYLOAD_ROWS","pending_messages"],
["both source and target omit mandatory payload",f=>{f.source.payloads.ideas=[];f.target.payloads.ideas=[];},"target_payloads","INVALID_PAYLOAD_ROWS","ideas"],
["target changed poll vote",f=>f.target.activity.votes[0].choice_index=0,"target_activity","ACTIVITY_MISMATCH","votes"],
["restored vote missing",f=>f.restored.activity.votes=[],"restored_activity","ACTIVITY_MISMATCH","votes"],
["target event occupancy corrupt",f=>f.target.activity.event_occupancy[0].taken=0,"target_activity","OCCUPANCY_MISMATCH","event_occupancy"],
["restored event start changed",f=>f.restored.activity.listing_event_fields[0].event_time="11:00","restored_activity","ACTIVITY_MISMATCH","listing_event_fields"],
["restore lost announcement",f=>f.restored.activity.announcements=[],"restored_activity","ACTIVITY_MISMATCH","announcements"],
["arbitrary source text rejected",f=>f.source.payloads.messages[0].body="raw data","target_payloads","INVALID_PAYLOAD_ROWS","messages"],
["unexpected top-level field",f=>f.approved=true,"input","INVALID_COMPLETE_SNAPSHOT"]
];
for(const [name,mutate,stage,code,table] of cases)test(name,()=>{const f=fixture();mutate(f);assert.deepEqual(verify(f),{ok:false,stage,code,...(table?{table}:{}),live_cutover_authorized:false});});
