import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifySyntheticInventoryAcceptance as verify} from '../../../compat/verify-synthetic-inventory-acceptance.mjs';
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

function profileFixture(){
 const {f,state,objects}=full();
 const [a,b]=f.source.accounts;
 const profiles=[{user_id:a.user_id,first_name:'synthetic:First',last_name:'synthetic:Last',class_name:'8Б',city:null,avatar_url:'',person_type:'student',staff_position:null,staff_verification_status:'not_required'},
  {user_id:b.user_id,first_name:'synthetic:Staff',last_name:null,class_name:null,city:'',avatar_url:null,person_type:'school_staff',staff_position:'synthetic:Teacher',staff_verification_status:'pending'}];
 return {f,state,objects,profiles};
}

function input(){
 const {f,state,profiles}=profileFixture();
 // Deliberately explicit expected counts, not derived from the exported rows.
 return {source:{snapshot:f.source,state:structuredClone(state),profiles:structuredClone(profiles)},
 target:{snapshot:f.target,state:structuredClone(state),profiles:structuredClone(profiles)},
 restored:{snapshot:f.restored,state:structuredClone(state),profiles:structuredClone(profiles)},
 inventory:{snapshot_id:'synthetic-batch',counts:{profiles:2,listings:1,ideas:1,messages:1,pending_messages:1,favorites:1,media:1,idea_images:0,event_registrations:1,event_occupancy:1,announcements:1,polls:1,votes:1}}};
}
test('independent inventory covers thirteen logical tables',()=>{const r=verify(input());assert.equal(r.ok,true);assert.equal(r.inventory_tables,13);assert.equal(r.live_cutover_authorized,false);});
for(const [name,mutate,stage,code,table] of [
 ['missing table',f=>delete f.inventory.counts.votes,'inventory','INVALID_SOURCE_INVENTORY'],
 ['unknown table',f=>f.inventory.counts.unmapped=1,'inventory','INVALID_SOURCE_INVENTORY'],
 ['different snapshot',f=>f.inventory.snapshot_id='synthetic-other','inventory','INVALID_SOURCE_INVENTORY'],
 ['negative count',f=>f.inventory.counts.ideas=-1,'inventory','INVALID_SOURCE_COUNT','ideas'],
 ['fractional count',f=>f.inventory.counts.ideas=0.5,'inventory','INVALID_SOURCE_COUNT','ideas'],
 ['string count',f=>f.inventory.counts.ideas='1','inventory','INVALID_SOURCE_COUNT','ideas'],
 ['oversized count',f=>f.inventory.counts.ideas=10001,'inventory','INVALID_SOURCE_COUNT','ideas'],
 ['same omission across all manifests',f=>{for(const k of ['source','target','restored'])f[k].snapshot.activity.votes=[];},'source','SOURCE_INVENTORY_COUNT_MISMATCH','votes'],
 ['extra matching rows beyond inventory',f=>f.inventory.counts.announcements=0,'source','SOURCE_INVENTORY_COUNT_MISMATCH','announcements'],
 ['missing inventory',f=>delete f.inventory,'input','INVALID_INVENTORY_INPUT']
])test(name,()=>{const f=input();mutate(f);const r=verify(f);assert.equal(r.ok,false);assert.equal(r.stage,stage);assert.equal(r.code,code);assert.equal(r.table,table);assert.equal(r.live_cutover_authorized,false);});
test('matching omission of message body and metadata is not accepted',()=>{
 const f=input();for(const k of ['source','target','restored']){f[k].snapshot.content.messages=[];f[k].snapshot.payloads.messages=[];f[k].state.messages=[];}
 assert.equal(verify(f).code,'SOURCE_INVENTORY_COUNT_MISMATCH');assert.equal(verify(f).table,'messages');
});
test('inventory does not replace normal reconciliation',()=>{const f=input();f.target.snapshot.activity.votes[0].choice_index=0;assert.equal(verify(f).code,'ACTIVITY_MISMATCH');});
