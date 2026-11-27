import {verifySyntheticAccountRehearsal} from './verify-synthetic-account-rehearsal.mjs';

// Synthetic-only profile payload comparison, independent of provider identity.
// Real avatars and unknown profile states are explicit blockers, never silently dropped.
const fields=['user_id','first_name','last_name','class_name','city','avatar_url','person_type','staff_position','staff_verification_status'];
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const dummy=(x,max)=>x===null||x===''||(typeof x==='string'&&x.length<=max&&/^synthetic:[a-zA-Z0-9 _.-]{1,100}$/.test(x));
const fail=code=>({ok:false,code,live_cutover_authorized:false});
export function verifySyntheticProfileDetails(accounts,source,target){
 if(!Array.isArray(accounts)||accounts.length>10000)return fail('INVALID_PROFILE_ACCOUNTS');
 const normalized=accounts.map(row=>({...row,issuer:'https://synthetic.invalid',subject:row?.user_id}));
 if(!verifySyntheticAccountRehearsal(accounts,normalized).ok)return fail('INVALID_PROFILE_ACCOUNTS');
 const expected=new Set(accounts.map(row=>row.user_id));
 function index(rows){
  if(!Array.isArray(rows)||rows.length!==expected.size)return fail('INVALID_PROFILE_DETAIL_ROWS');
  const map=new Map();
  for(const row of rows){
   if(!exact(row,fields)||!expected.has(row.user_id)||map.has(row.user_id))return fail('INVALID_PROFILE_DETAIL_ROWS');
   if(!dummy(row.first_name,60)||!dummy(row.last_name,60)||!dummy(row.city,120)||!dummy(row.staff_position,100))return fail('INVALID_SYNTHETIC_PROFILE_TEXT');
   if(row.avatar_url!==null&&row.avatar_url!=='')return fail('AVATAR_RECONCILIATION_REQUIRED');
   if(row.class_name!==null&&row.class_name!==''&&(typeof row.class_name!=='string'||!/^(?:[5-9]|1[01])[АБВГК]$/u.test(row.class_name)))return fail('INVALID_PROFILE_CLASS');
   if(!['student','school_staff','parent'].includes(row.person_type)||!['not_required','pending','approved','rejected'].includes(row.staff_verification_status))return fail('INVALID_PROFILE_PERSON_TYPE');
   if(row.person_type!=='student'&&row.class_name!==null&&row.class_name!=='')return fail('PROFILE_CLASS_CONFLICT');
   if(row.person_type==='school_staff'){
    if(!row.staff_position||row.staff_verification_status==='not_required')return fail('INVALID_STAFF_STATE');
   }else if((row.staff_position!==null&&row.staff_position!=='')||row.staff_verification_status!=='not_required')return fail('INVALID_STAFF_STATE');
   map.set(row.user_id,JSON.stringify(fields.map(k=>row[k])));
  }
  return {ok:true,map};
 }
 const a=index(source);if(!a.ok)return a;
 const b=index(target);if(!b.ok)return b;
 for(const [key,value] of a.map)if(b.map.get(key)!==value)return fail('PROFILE_DETAILS_MISMATCH');
 return {ok:true,code:'SYNTHETIC_PROFILE_DETAILS_MATCH',count:expected.size,live_cutover_authorized:false};
}
