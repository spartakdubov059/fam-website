import { createHash } from 'node:crypto';
import { mapLegacyProfileForMigration } from '../app/backend/services/legacy-profile-migration.mjs';
// Disposable synthetic rehearsal only. No real exporter, provider credentials, or live route.
const fail = code => ({ok:false,code});
const fields = Object.freeze(['user_id','school_id','role','active','first_name','last_name','class_name','city','avatar_url','person_type','staff_position','staff_verification_status']);
const nullable = new Set(['first_name','last_name','class_name','city','avatar_url','staff_position']);
const versionOf = row => createHash('sha256').update(JSON.stringify(['fam-ru-synthetic-profile-v1',...fields.map(key=>row[key])])).digest('hex');
const sameProfile = (old,row) => old.profile_version===row.profile_version &&
  fields.every(k=>(nullable.has(k)?old[k]??null:old[k])===row[k]);
export function prepareSyntheticProfileBatch(input) {
  if(!Array.isArray(input)||input.length===0||input.length>25)return fail('INVALID_BATCH');
  const seen=new Set(),profiles=[];
  for(const source of input){
    const mapped=mapLegacyProfileForMigration(source);
    if(!mapped.ok)return fail(mapped.code);
    const row=mapped.profile;
    if(!/^edededed-eded-4ded-8ded-edededed[0-9a-f]{4}$/.test(row.user_id))return fail('NON_SYNTHETIC_UUID');
    if(!['Synthetic',null,''].includes(row.first_name)||!['Migration',null,''].includes(row.last_name)||
       !['Synthetic staff',null,''].includes(row.staff_position)||![null,''].includes(row.city))return fail('NON_SYNTHETIC_PROFILE');
    if(seen.has(row.user_id))return fail('DUPLICATE_BATCH_UUID');
    seen.add(row.user_id);
    profiles.push(Object.freeze({...row,profile_version:versionOf(row)}));
  }
  return {ok:true,profiles:Object.freeze(profiles.sort((a,b)=>a.user_id.localeCompare(b.user_id)))};
}
export function createSyntheticProfileStageRepository(sql) {
  if(typeof sql!=='function'||typeof sql.begin!=='function')throw new TypeError('transactional query client required');
  const rows=result=>{if(!Array.isArray(result)||!Array.isArray(result[0]))throw Error('invalid query result');return result[0];};
  return Object.freeze({
    async stageBatch(input) {
      let batch;
      try {batch=prepareSyntheticProfileBatch(input);}catch{return fail('INVALID_BATCH');}
      if(!batch.ok)return batch;
      try{
        return await sql.begin(async tx=>{
          const inserts=[];
          // Validate the complete batch before inserting any row.
          for(const row of batch.profiles){
            const existing=rows(await tx`SELECT * FROM fam_legacy_migration_profiles WHERE user_id = ${row.user_id};`);
            if(existing.length>1)return fail('STAGING_CONFLICT');
            if(existing.length===1){
              if(!sameProfile(existing[0],row))return fail('STAGING_CONFLICT');
              // Never reset readiness, including after the account was linked.
              continue;
            }
            if(rows(await tx`SELECT user_id FROM fam_user_profiles WHERE user_id = ${row.user_id} LIMIT 1;`).length||
               rows(await tx`SELECT user_id FROM fam_legacy_migration_links WHERE user_id = ${row.user_id} LIMIT 1;`).length||
               rows(await tx`SELECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${row.user_id} LIMIT 1;`).length)return fail('STAGING_CONFLICT');
            inserts.push(row);
          }
          for(const row of inserts){
            await tx`INSERT INTO fam_legacy_migration_profiles
              (user_id, profile_version, ready, school_id, role, active, first_name, last_name, class_name, city, avatar_url,
                person_type, staff_position, staff_verification_status)
              VALUES (${row.user_id}, ${row.profile_version}, ${row.active}, ${row.school_id}, ${row.role}, ${row.active},
                IF(${row.first_name===null}, NULL, ${row.first_name??''}),
                IF(${row.last_name===null}, NULL, ${row.last_name??''}),
                IF(${row.class_name===null}, NULL, ${row.class_name??''}),
                IF(${row.city===null}, NULL, ${row.city??''}),
                IF(${row.avatar_url===null}, NULL, ${row.avatar_url??''}),
                ${row.person_type}, IF(${row.staff_position===null}, NULL, ${row.staff_position??''}),
                ${row.staff_verification_status});`;
            const stored=rows(await tx`SELECT * FROM fam_legacy_migration_profiles WHERE user_id = ${row.user_id};`);
            if(stored.length!==1||!sameProfile(stored[0],row)||stored[0].ready!==row.active)throw Error('staging postcondition failed');
          }
          return {ok:true,code:'SYNTHETIC_BATCH_STAGED',inserted:inserts.length,unchanged:batch.profiles.length-inserts.length};
        });
      }catch{return fail('STAGING_UNAVAILABLE');}
    }
  });
}
