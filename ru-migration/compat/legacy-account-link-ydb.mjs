// Prototype for the isolated rehearsal only; do not connect this to a live route.
import { prepareSyntheticProfileBatch } from './synthetic-profile-stage-ydb.mjs';
export function createYdbLegacyAccountLinkRepository(sql) {
  if(typeof sql!=='function'||typeof sql.begin!=='function')throw new TypeError('transactional query client required');
  const fail=()=>({ok:false,code:'LINK_UNAVAILABLE'});
  const hex64=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
  const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
  const rows=result=>{if(!Array.isArray(result)||!Array.isArray(result[0]))throw Error('invalid query result');return result[0];};
  return Object.freeze({
    async linkVerifiedAccount(input){
      if(!input||typeof input!=='object'||Array.isArray(input)||
         Object.keys(input).length!==5||!['challengeId','legacyUserId','profileVersion','issuer','subject'].every(k=>Object.hasOwn(input,k)))return fail();
      const {challengeId,legacyUserId,profileVersion,issuer,subject}=input;
      if(!hex64(challengeId)||!uuid(legacyUserId)||!hex64(profileVersion)||issuer!=='https://login.yandex.ru'||typeof subject!=='string'||!/^\d{1,40}$/.test(subject))return fail();
      try {
        return await sql.begin(async tx=>{
          const challenges=rows(await tx`SELECT user_id FROM fam_legacy_migration_challenges
            WHERE challenge_id = ${challengeId} AND user_id = ${legacyUserId} AND profile_version = ${profileVersion}
              AND issuer = ${issuer} AND subject = ${subject} AND consumed = false AND expires_at > CurrentUtcTimestamp();`);
          if(challenges.length!==1)return fail();
          const profiles=rows(await tx`SELECT user_id, school_id, role, active, first_name, last_name, class_name, city, avatar_url,
            person_type, staff_position, staff_verification_status
            FROM fam_legacy_migration_profiles WHERE user_id = ${legacyUserId} AND profile_version = ${profileVersion} AND ready = true AND active = true;`);
          if(profiles.length!==1)return fail();
          const p=profiles[0];
          const prepared=prepareSyntheticProfileBatch([{id:p.user_id,school_id:p.school_id,role:p.role,active:p.active,
            first_name:p.first_name??null,last_name:p.last_name??null,class_name:p.class_name??null,city:p.city??null,
            avatar_url:p.avatar_url??null,person_type:p.person_type,staff_position:p.staff_position??null,staff_verification_status:p.staff_verification_status}]);
          // The stored version is not evidence that the staged columns still match it.
          // Recompute the canonical synthetic digest inside the same transaction.
          if(!prepared.ok||prepared.profiles.length!==1||prepared.profiles[0].profile_version!==profileVersion||p.user_id!==legacyUserId||p.active!==true)return fail();
          if(rows(await tx`SELECT user_id FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`).length||
             rows(await tx`SELECT user_id FROM fam_user_profiles WHERE user_id = ${legacyUserId} LIMIT 1;`).length||
             rows(await tx`SELECT user_id FROM fam_legacy_migration_links WHERE user_id = ${legacyUserId} LIMIT 1;`).length||
             rows(await tx`SELECT request_id FROM fam_profile_requests WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1;`).length||
             rows(await tx`SELECT user_id FROM fam_account_deletion_jobs WHERE user_id = ${legacyUserId} LIMIT 1;`).length||
             rows(await tx`SELECT target_id FROM fam_account_suspension_open WHERE target_id = ${legacyUserId} LIMIT 1;`).length)return fail();
          // INSERT (not UPSERT) protects existing provider keys. Copy from staged columns
          // to retain nullable fields and the original user UUID exactly.
          await tx`INSERT INTO fam_user_profiles
            SELECT ${issuer} AS issuer, ${subject} AS subject, user_id, school_id, role, active,
              first_name, last_name, class_name, city, avatar_url, person_type, staff_position, staff_verification_status
            FROM fam_legacy_migration_profiles WHERE user_id = ${legacyUserId} AND profile_version = ${profileVersion} AND ready = true AND active = true;`;
          await tx`INSERT INTO fam_legacy_migration_links (user_id, challenge_id, issuer, subject, profile_version, created_at)
            VALUES (${legacyUserId}, ${challengeId}, ${issuer}, ${subject}, ${profileVersion}, CurrentUtcTimestamp());`;
          await tx`UPDATE fam_legacy_migration_profiles SET ready = false WHERE user_id = ${legacyUserId} AND profile_version = ${profileVersion};`;
          await tx`UPDATE fam_legacy_migration_challenges SET consumed = true WHERE challenge_id = ${challengeId} AND consumed = false AND expires_at > CurrentUtcTimestamp();`;
          const done=rows(await tx`SELECT consumed FROM fam_legacy_migration_challenges WHERE challenge_id = ${challengeId};`);
          const inserted=rows(await tx`SELECT user_id FROM fam_user_profiles WHERE issuer = ${issuer} AND subject = ${subject};`);
          if(done.length!==1||done[0].consumed!==true||inserted.length!==1||inserted[0].user_id!==legacyUserId)throw Error('link postcondition failed');
          return {ok:true,code:'LINKED'};
        });
      }catch{return fail();}
    }
  });
}
