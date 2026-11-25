import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifySyntheticProfileDetails as verify} from '../../../compat/verify-synthetic-profile-details.mjs';
import {encodeSyntheticProfileBackup as encode,decodeSyntheticProfileBackup as decode,verifySyntheticProfileAcceptance as acceptance} from '../../../compat/synthetic-profile-backup-envelope.mjs';
import {encodeSyntheticStateBackup as encodeV3} from '../../../compat/synthetic-state-backup-envelope.mjs';
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
test('v4 round trip preserves all profile details and null versus empty values',()=>{
 const {f,state,objects,profiles}=profileFixture();const b=encode(f.source,objects,state,profiles);assert.equal(b.ok,true);
 const r=decode(b.bytes,b.sha256);assert.equal(r.ok,true);assert.deepEqual(r.profiles,profiles);assert.deepEqual(r.snapshot,f.source);
 assert.equal(acceptance({source:{snapshot:f.source,state,profiles},target:{snapshot:f.target,state,profiles},restored:{snapshot:r.snapshot,state:r.state,profiles:r.profiles}}).ok,true);
 assert.equal(r.live_cutover_authorized,false);
});
test('v3 is not a profile-complete archive',()=>{const {f,state,objects}=profileFixture();const b=encodeV3(f.source,objects,state);assert.equal(b.ok,true);assert.equal(decode(b.bytes,b.sha256).code,'UNSUPPORTED_BACKUP_FORMAT');});
test('missing profile section is blocked',()=>{const {f,state,objects}=profileFixture();assert.equal(encode(f.source,objects,state,undefined).code,'INVALID_PROFILE_DETAIL_ROWS');});
test('order does not matter',()=>{const {f,profiles}=profileFixture();assert.equal(verify(f.source.accounts,profiles,[...profiles].reverse()).ok,true);});
const cases=[
 ['changed class',s=>s[0].class_name='9Б','PROFILE_DETAILS_MISMATCH'],
 ['changed name',s=>s[0].first_name='synthetic:Changed','PROFILE_DETAILS_MISMATCH'],
 ['null versus empty city',s=>s[0].city='','PROFILE_DETAILS_MISMATCH'],
 ['staff approval changed',s=>s[1].staff_verification_status='approved','PROFILE_DETAILS_MISMATCH'],
 ['missing profile',s=>s.pop(),'INVALID_PROFILE_DETAIL_ROWS'],
 ['duplicate profile',s=>s[1]={...s[0]},'INVALID_PROFILE_DETAIL_ROWS'],
 ['unknown profile',s=>s[0].user_id='synthetic-unknown','INVALID_PROFILE_DETAIL_ROWS'],
 ['unknown field',s=>s[0].email='synthetic:email','INVALID_PROFILE_DETAIL_ROWS'],
 ['raw text',s=>s[0].first_name='Raw','INVALID_SYNTHETIC_PROFILE_TEXT'],
 ['unresolved avatar',s=>s[0].avatar_url='synthetic:old-avatar','AVATAR_RECONCILIATION_REQUIRED'],
 ['staff class',s=>s[1].class_name='8Б','PROFILE_CLASS_CONFLICT'],
 ['staff missing position',s=>s[1].staff_position=null,'INVALID_STAFF_STATE'],
 ['student staff approval',s=>s[0].staff_verification_status='approved','INVALID_STAFF_STATE'],
 ['invalid class',s=>s[0].class_name='12А','INVALID_PROFILE_CLASS'],
 ['unknown type',s=>s[0].person_type='unknown','INVALID_PROFILE_PERSON_TYPE']
];
for(const [name,mutate,code] of cases)test(name,()=>{const {f,profiles}=profileFixture();const next=structuredClone(profiles);mutate(next);assert.equal(verify(f.source.accounts,profiles,next).code,code);});
test('restored profile difference blocks combined acceptance',()=>{const {f,state,profiles}=profileFixture();const next=structuredClone(profiles);next[1].staff_verification_status='approved';assert.deepEqual(acceptance({source:{snapshot:f.source,state,profiles},target:{snapshot:f.target,state,profiles},restored:{snapshot:f.restored,state,profiles:next}}),{ok:false,code:'PROFILE_DETAILS_MISMATCH',stage:'restored_profiles',live_cutover_authorized:false});});
