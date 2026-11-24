import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySyntheticMigrationReconciliation as verify } from '../../../compat/verify-synthetic-migration-reconciliation.mjs';

const fixture = () => {
  const sourceAccounts = [
    {user_id:'synthetic-a',school_id:'synthetic-school',role:'student',active:true},
    {user_id:'synthetic-b',school_id:'synthetic-school',role:'student',active:true}
  ];
  const targetAccounts = sourceAccounts.map((row,i)=>({...row,issuer:'https://synthetic.invalid',subject:'synthetic-identity-'+i}));
  const sourceContent = {
    profiles:sourceAccounts.map(({user_id,school_id})=>({user_id,school_id})),
    listings:[{id:'synthetic-listing',user_id:'synthetic-a',school_id:'synthetic-school',image_key:'synthetic-photo'}],
    ideas:[{id:'synthetic-idea',user_id:'synthetic-a',school_id:'synthetic-school'}],
    messages:[{id:'synthetic-message',sender_id:'synthetic-b',receiver_id:'synthetic-a',school_id:'synthetic-school',listing_id:'synthetic-listing'}],
    pending_messages:[{id:'synthetic-pending',sender_id:'synthetic-a',receiver_id:'synthetic-b',school_id:'synthetic-school',listing_id:'synthetic-listing'}],
    favorites:[{user_id:'synthetic-b',listing_id:'synthetic-listing'}],
    media:[{object_key:'synthetic-photo',user_id:'synthetic-a'},{object_key:'synthetic-photo-other',user_id:'synthetic-a'}],
    idea_images:[]
  };
  return {sourceAccounts,targetAccounts,sourceContent,targetContent:structuredClone(sourceContent)};
};

const cases = [
  ['matches equal manifests',()=>{},'SYNTHETIC_MIGRATION_RECONCILIATION_PASS'],
  ['ignores row and object-key ordering',x=>{
    for(const table of Object.keys(x.targetContent)){
      x.targetContent[table]=x.targetContent[table].reverse().map(row=>Object.fromEntries(Object.entries(row).reverse()));
    }
    x.targetAccounts.reverse();
  },'SYNTHETIC_MIGRATION_RECONCILIATION_PASS'],
  ['detects missing pending message',x=>{x.targetContent.pending_messages=[];},'CONTENT_METADATA_MISMATCH','pending_messages'],
  ['detects same-count changed media association',x=>{x.targetContent.listings[0].image_key='synthetic-photo-other';},'CONTENT_METADATA_MISMATCH','listings'],
  ['detects same-count changed message identity',x=>{x.targetContent.messages[0].id='synthetic-different';},'CONTENT_METADATA_MISMATCH','messages'],
  ['detects same-count swapped conversation participants',x=>{const m=x.targetContent.messages[0]; [m.sender_id,m.receiver_id]=[m.receiver_id,m.sender_id];},'CONTENT_METADATA_MISMATCH','messages'],
  ['rejects privilege change before content comparison',x=>{x.targetAccounts[0].role='school_admin';},'PROFILE_INVARIANT_CHANGED','accounts'],
  ['rejects source account missing from content projection',x=>{
    x.sourceAccounts.push({user_id:'synthetic-extra',school_id:'synthetic-school',role:'student',active:true});
    x.targetAccounts.push({...x.sourceAccounts[2],issuer:'https://synthetic.invalid',subject:'synthetic-extra-y'});
  },'SOURCE_ACCOUNT_CONTENT_MISMATCH','source_content'],
  ['rejects unexpected target content profile',x=>{x.targetContent.profiles.push({user_id:'synthetic-extra',school_id:'synthetic-school'});},'TARGET_ACCOUNT_CONTENT_MISMATCH','target_content'],
  ['rejects duplicate target record rather than normalizing it away',x=>{x.targetContent.media.push({...x.targetContent.media[0]});},'DUPLICATE_KEY','target_content'],
  ['rejects extra raw fields',x=>{x.targetContent.messages[0].body='synthetic raw body';},'INVALID_SYNTHETIC_ROW','target_content']
];

for(const [name,mutate,code,stage] of cases) test(name,()=>{
  const input=fixture(); mutate(input);
  const result=verify(input);
  assert.equal(result.code,code);
  if(stage) {
    assert.deepEqual(result,{ok:false,code,stage});
  } else {
    assert.equal(result.ok,true);
    assert.equal(result.accounts,2);
    assert.equal(result.counts.pending_messages,1);
  }
});

test('malformed top-level payload fails closed',()=>{
  assert.deepEqual(verify(null),{ok:false,code:'INVALID_RECONCILIATION_INPUT',stage:'input'});
});
