import { test } from 'node:test';
import assert from 'node:assert/strict';
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
