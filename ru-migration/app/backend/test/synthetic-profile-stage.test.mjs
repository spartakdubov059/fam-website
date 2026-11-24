import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSyntheticProfileBatch as prepare } from '../../../compat/synthetic-profile-stage-ydb.mjs';
function profile(id='edededed-eded-4ded-8ded-edededed0010'){
 return {id,school_id:'lyceum_3',role:'student',active:true,first_name:'Synthetic',last_name:'Migration',class_name:'7А',city:null,avatar_url:null,person_type:'student',staff_position:null,staff_verification_status:'not_required'};
}
test('preserves original UUID and stable profile version',()=>{
 const a=profile();const b=Object.fromEntries(Object.entries(a).reverse());
 const result=prepare([a]);assert.equal(result.ok,true);
 assert.equal(result.profiles[0].user_id,a.id);
 assert.match(result.profiles[0].profile_version,/^[0-9a-f]{64}$/);
 assert.equal(result.profiles[0].profile_version,prepare([b]).profiles[0].profile_version);
});
test('a change of role, activity, or nullable fields changes version',()=>{
 const base=prepare([profile()]).profiles[0].profile_version;
 for(const delta of [{role:'school_admin'},{active:false},{city:''}]){
   const result=prepare([{...profile(),...delta}]);
   assert.equal(result.ok,true);assert.notEqual(result.profiles[0].profile_version,base);
 }
});
test('duplicate UUID is rejected before database access',()=>{
 assert.deepEqual(prepare([profile(),profile()]),{ok:false,code:'DUPLICATE_BATCH_UUID'});
});
test('non-rehearsal UUID and non-synthetic names are rejected',()=>{
 assert.equal(prepare([profile('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]).code,'NON_SYNTHETIC_UUID');
 assert.equal(prepare([{...profile(),first_name:'Unexpected'}]).code,'NON_SYNTHETIC_PROFILE');
});
test('identity binding cannot be injected into a profile',()=>{
 assert.equal(prepare([{...profile(),subject:'123'}]).code,'INVALID_PROFILE_FIELDS');
});
test('bounds the number of records in a transaction',()=>{
 for(const value of [null,[],Array(26).fill(profile())])assert.equal(prepare(value).code,'INVALID_BATCH');
});
test('input ordering does not affect staged order or digests',()=>{
 const a=profile(),b=profile('edededed-eded-4ded-8ded-edededed0011');
 assert.deepEqual(prepare([a,b]),prepare([b,a]));
});
