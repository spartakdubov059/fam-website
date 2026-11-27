import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapLegacyProfileForMigration } from '../services/legacy-profile-migration.mjs';
const fixture = ()=>({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',school_id:'lyceum_3',role:'student',active:true,first_name:'Synthetic',last_name:'Pupil',class_name:'7А',city:null,avatar_url:null,person_type:'student',staff_position:null,staff_verification_status:'not_required'});
const cases = [
  ["preserves original UUID and profile fields", ()=>{}, "PASS"],
  ["preserves inactive status", x=>x.active=false, "PASS"],
  ["preserves admin role without granting a new identity", x=>x.role='school_admin', "PASS"],
  ["preserves empty versus null values", x=>{x.city='';x.avatar_url='';}, "PASS"],
  ["rejects noncanonical UUID", x=>x.id=x.id.toUpperCase(), "INVALID_LEGACY_ID"],
  ["rejects unknown school", x=>x.school_id='unknown', "INVALID_PROFILE_AUTHORITY"],
  ["rejects unknown role", x=>x.role='superadmin', "INVALID_PROFILE_AUTHORITY"],
  ["rejects ambiguous activity", x=>x.active=null, "INVALID_PROFILE_AUTHORITY"],
  ["rejects unexpected fields", x=>x.email='synthetic@example.invalid', "INVALID_PROFILE_FIELDS"],
  ["rejects missing fields", x=>delete x.staff_position, "INVALID_PROFILE_FIELDS"],
  ["rejects excessive name instead of truncating", x=>x.first_name='a'.repeat(81), "INVALID_PROFILE_TEXT"],
  ["rejects control characters", x=>x.city='bad\nvalue', "INVALID_PROFILE_TEXT"],
  ["rejects malformed class", x=>x.class_name='12А', "INVALID_CLASS"],
  ["rejects unknown participant category", x=>x.person_type='other', "INVALID_PERSON_TYPE"],
  ["rejects class assigned to parent", x=>x.person_type='parent', "PERSON_TYPE_CLASS_CONFLICT"],
  ["preserves valid staff approval", x=>{x.person_type='school_staff';x.class_name=null;x.staff_position='Synthetic staff';x.staff_verification_status='approved';}, "PASS"],
  ["rejects staff missing verified-state provenance", x=>{x.person_type='school_staff';x.class_name=null;x.staff_position='Synthetic staff';}, "STAFF_REVIEW_REQUIRED"],
  ["rejects staff status on student", x=>x.staff_verification_status='approved', "STAFF_REVIEW_REQUIRED"],
  ["rejects nonempty legacy avatar instead of losing it", x=>x.avatar_url='https://synthetic.invalid/avatar', "AVATAR_RECONCILIATION_REQUIRED"],
  ["rejects fake Yandex binding in source", x=>x.subject='1234', "INVALID_PROFILE_FIELDS"]
];
for(const [name,mutate,want] of cases) test(name,()=>{const source=fixture();mutate(source);const result=mapLegacyProfileForMigration(source);if(want==='PASS'){const {id,...rest}=source;assert.deepEqual(result,{ok:true,profile:{user_id:id,...rest}});assert.equal(Object.hasOwn(result.profile,'issuer'),false);assert.equal(Object.hasOwn(result.profile,'subject'),false);}else assert.deepEqual(result,{ok:false,code:want});});

test('profile migration fields stay aligned with source and YDB schemas without staging login identity',()=>{
 const root=new URL('../../../../',import.meta.url);
 const source=readFileSync(new URL('supabase/migrations/20261116120000_fam_person_types_and_school_applicant_privacy.sql',root),'utf8');
 const sourceCore=readFileSync(new URL('index.html',root),'utf8');
 const staged=readFileSync(new URL('../../../compat/legacy-account-link-schema.yql',import.meta.url),'utf8');
 const target=readFileSync(new URL('../schema/02_user_profiles.yql',import.meta.url),'utf8')+
  readFileSync(new URL('../schema/24_person_types.yql',import.meta.url),'utf8');
 const input=fixture(),mapped=mapLegacyProfileForMigration(input);
 assert.equal(mapped.ok,true);
 assert.deepEqual(Object.keys(mapped.profile).sort(),['user_id','school_id','role','active','first_name','last_name','class_name','city','avatar_url','person_type','staff_position','staff_verification_status'].sort());
 for(const field of ['person_type','staff_position','staff_verification_status']){
  assert.match(source,new RegExp(`add column if not exists\\s+${field}\\b`,'i'));
  assert.match(target,new RegExp(`add column ${field}\\b`,'i'));
  assert.match(staged,new RegExp(`\\b${field}\\b`,'i'));
 }
 for(const field of ['id','school_id','role','first_name','last_name','class_name','city','avatar_url'])assert.match(sourceCore,new RegExp(`\\b${field}\\b`));
 assert.doesNotMatch(staged,/\\b(issuer|subject|email|password)\\b/i);
 assert.equal(Object.hasOwn(mapped.profile,'issuer'),false);
 assert.equal(Object.hasOwn(mapped.profile,'subject'),false);
});
