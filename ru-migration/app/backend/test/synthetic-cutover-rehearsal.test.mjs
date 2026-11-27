import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySyntheticCutoverRehearsal as verify } from '../../../compat/verify-synthetic-cutover-rehearsal.mjs';

function fixture(){
  const accounts=[
    {user_id:'synthetic-a',school_id:'synthetic-school',role:'student',active:true},
    {user_id:'synthetic-b',school_id:'synthetic-school',role:'student',active:false}
  ];
  const content={
    profiles:accounts.map(({user_id,school_id})=>({user_id,school_id})),
    listings:[{id:'synthetic-listing',user_id:'synthetic-a',school_id:'synthetic-school',image_key:'synthetic-photo'}],
    ideas:[],messages:[],pending_messages:[],favorites:[],
    media:[{object_key:'synthetic-photo',user_id:'synthetic-a'}],idea_images:[]
  };
  const objects=[{...content.media[0],byte_length:12,sha256:'a'.repeat(64)}];
  const source={snapshot_id:'synthetic-batch',accounts,content,objects};
  const target=structuredClone(source);
  target.accounts=accounts.map((row,i)=>({...row,issuer:'https://synthetic.invalid',subject:'synthetic-identity-'+i}));
  return {source,target,restored:structuredClone(source)};
}
test('three-way reconciliation passes but never authorizes live cutover',()=>{
  const result=verify(fixture());
  assert.equal(result.ok,true);assert.equal(result.accounts,2);assert.equal(result.attachments,1);
  assert.equal(result.live_cutover_authorized,false);
});
const cases=[
 ['missing restored snapshot',x=>delete x.restored,'input','INVALID_SNAPSHOT'],
 ['inconsistent snapshot version',x=>x.restored.snapshot_id='synthetic-old-batch','input','SNAPSHOT_ID_MISMATCH'],
 ['target lost account',x=>x.target.accounts.pop(),'target_data','MISSING_TARGET_ACCOUNT'],
 ['target changed owner',x=>x.target.content.media[0].user_id='synthetic-b','target_data','LISTING_MEDIA_OWNER'],
 ['target photo lost',x=>x.target.objects=[],'target_attachments','MISSING_TARGET_OBJECT'],
 ['target photo corrupt',x=>x.target.objects[0].sha256='b'.repeat(64),'target_attachments','ATTACHMENT_BYTES_MISMATCH'],
 ['restored account lost',x=>x.restored.accounts.pop(),'restored_data','UNEXPECTED_TARGET_ACCOUNT'],
 ['restored inactive account reactivated',x=>x.restored.accounts[1].active=true,'restored_data','PROFILE_INVARIANT_CHANGED'],
 ['restored listing lost',x=>x.restored.content.listings=[],'restored_data','CONTENT_METADATA_MISMATCH'],
 ['restored attachment lost',x=>x.restored.objects=[],'restored_attachments','MISSING_TARGET_OBJECT'],
 ['restored attachment changed',x=>x.restored.objects[0].sha256='b'.repeat(64),'restored_attachments','ATTACHMENT_BYTES_MISMATCH'],
 ['unexpected raw content',x=>x.restored.content.listings[0].description='raw','restored_data','INVALID_SYNTHETIC_ROW'],
 ['real snapshot identifier refused',x=>x.source.snapshot_id='production','input','SNAPSHOT_ID_MISMATCH']
];
for(const [name,mutate,stage,code] of cases)test(name,()=>{
 const input=fixture();mutate(input);assert.deepEqual(verify(input),{ok:false,stage,code});
});
