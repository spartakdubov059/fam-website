import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
import { createYdbLegacyAccountLinkRepository } from './legacy-account-link-ydb.mjs';
import { createSyntheticProfileStageRepository, prepareSyntheticProfileBatch } from './synthetic-profile-stage-ydb.mjs';
async function main(){
 const driver=new Driver('grpc://127.0.0.1:2136/local');
 try{
  await driver.ready();
  const client=query(driver);
  const sql=(strings,...values)=>{const stmt=client(strings,...values);stmt.on('error',()=>{});return stmt;};
  sql.begin=client.begin.bind(client);
  const repository=createYdbLegacyAccountLinkRepository(sql);
  const issuer='https://login.yandex.ru',versions=new Map();
  const ids=['edededed-eded-4ded-8ded-ededededed01','edededed-eded-4ded-8ded-ededededed02','edededed-eded-4ded-8ded-ededededed03','edededed-eded-4ded-8ded-ededededed04'];
  const subjects=['990000000001','990000000002','990000000003','990000000004','990000000005'];
  const challenges=['1','2','3','4','5','6'].map(c=>c.repeat(64));
  const seedProfile=async(id,ready=true,active=true)=>{
   const prepared=prepareSyntheticProfileBatch([{id,school_id:'lyceum_3',role:'student',active,first_name:'Synthetic',last_name:'Migration',class_name:'7А',city:null,avatar_url:null,person_type:'student',staff_position:null,staff_verification_status:'not_required'}]);
   assert.equal(prepared.ok,true);
   const version=prepared.profiles[0].profile_version;
   versions.set(id,version);
   await sql`INSERT INTO fam_legacy_migration_profiles (user_id, profile_version, ready, school_id, role, active, first_name, last_name, class_name, person_type, staff_verification_status)
    VALUES (${id}, ${version}, ${ready}, 'lyceum_3', 'student', ${active}, 'Synthetic', 'Migration', '7А', 'student', 'not_required');`;
  };
  const seedChallenge=async(challengeId,userId,subject,expired=false)=>{
   const version=versions.get(userId);assert.ok(version);
   if(expired)await sql`INSERT INTO fam_legacy_migration_challenges (challenge_id, user_id, profile_version, issuer, subject, expires_at, consumed)
     VALUES (${challengeId}, ${userId}, ${version}, ${issuer}, ${subject}, Unwrap(CurrentUtcTimestamp() - Interval('PT1M')), false);`;
   else await sql`INSERT INTO fam_legacy_migration_challenges (challenge_id, user_id, profile_version, issuer, subject, expires_at, consumed)
     VALUES (${challengeId}, ${userId}, ${version}, ${issuer}, ${subject}, Unwrap(CurrentUtcTimestamp() + Interval('PT4M')), false);`;
  };
  const input=(i,j,k)=>({challengeId:challenges[k],legacyUserId:ids[i],profileVersion:versions.get(ids[i]),issuer,subject:subjects[j]});
  const fail={ok:false,code:'LINK_UNAVAILABLE'},success={ok:true,code:'LINKED'};
  await seedProfile(ids[0]);await seedChallenge(challenges[0],ids[0],subjects[0]);
  assert.deepEqual(await repository.linkVerifiedAccount({...input(0,0,0),subject:subjects[4]}),fail);
  assert.deepEqual(await repository.linkVerifiedAccount({...input(0,0,0),profileVersion:'e'.repeat(64)}),fail);
  assert.deepEqual(await repository.linkVerifiedAccount(input(0,0,0)),success);
  assert.deepEqual(await repository.linkVerifiedAccount(input(0,0,0)),fail);
  const actor=await createDatabaseActorResolver(sql)({issuer,subject:subjects[0]});
  assert.equal(actor.id,ids[0]);assert.equal(actor.school_id,'lyceum_3');assert.equal(actor.role,'student');
  assert.equal(actor.class_name,'7А');assert.equal(actor.avatar_url,null);
  await seedProfile(ids[1]);await seedChallenge(challenges[1],ids[1],subjects[0]);
  assert.deepEqual(await repository.linkVerifiedAccount(input(1,0,1)),fail,'existing identity must not be overwritten');
  await seedChallenge(challenges[2],ids[1],subjects[1],true);
  assert.deepEqual(await repository.linkVerifiedAccount(input(1,1,2)),fail,'expired challenge must not be usable');
  await seedProfile(ids[2]);await seedChallenge(challenges[3],ids[2],subjects[2]);await seedChallenge(challenges[4],ids[2],subjects[3]);
  const race=await Promise.all([repository.linkVerifiedAccount(input(2,2,3)),repository.linkVerifiedAccount(input(2,3,4))]);
  assert.equal(race.filter(x=>x.ok).length,1,'one legacy UUID can be linked only once');
  const linked=await sql`SELECT user_id FROM fam_user_profiles WHERE user_id = ${ids[2]};`;
  assert.equal(linked[0].length,1);
  await seedProfile(ids[3]);await seedChallenge(challenges[5],ids[3],subjects[4]);
  const failingSql=(...args)=>sql(...args);
  failingSql.begin=callback=>sql.begin(tx=>callback((strings,...values)=>{
   if(strings.join(' ').includes('UPDATE fam_legacy_migration_challenges'))throw Error('synthetic transaction failure');
   return tx(strings,...values);
  }));
  assert.deepEqual(await createYdbLegacyAccountLinkRepository(failingSql).linkVerifiedAccount(input(3,4,5)),fail);
  const afterProfile=await sql`SELECT user_id FROM fam_user_profiles WHERE user_id = ${ids[3]};`;
  const afterLedger=await sql`SELECT user_id FROM fam_legacy_migration_links WHERE user_id = ${ids[3]};`;
  const afterStage=await sql`SELECT ready FROM fam_legacy_migration_profiles WHERE user_id = ${ids[3]};`;
  const afterChallenge=await sql`SELECT consumed FROM fam_legacy_migration_challenges WHERE challenge_id = ${challenges[5]};`;
  assert.equal(afterProfile[0].length,0);assert.equal(afterLedger[0].length,0);
  assert.equal(afterStage[0][0].ready,true);assert.equal(afterChallenge[0][0].consumed,false);
  assert.deepEqual(await repository.linkVerifiedAccount(input(3,4,5)),success,'rolled-back request can be retried');
  // Two different legacy accounts competing for the same provider identity.
  const extraIds=['edededed-eded-4ded-8ded-ededededed05','edededed-eded-4ded-8ded-ededededed06','edededed-eded-4ded-8ded-ededededed07','edededed-eded-4ded-8ded-ededededed08','edededed-eded-4ded-8ded-ededededed09','edededed-eded-4ded-8ded-ededededed0a','edededed-eded-4ded-8ded-ededededed0b'];
  const extraSubjects=['990000000006','990000000007','990000000008','990000000009','990000000010','990000000011'];
  const extraChallenges=['7','8','9','a','b','c','d'].map(c=>c.repeat(64));
  const bind=(i,j,k)=>({challengeId:extraChallenges[k],legacyUserId:extraIds[i],profileVersion:versions.get(extraIds[i]),issuer,subject:extraSubjects[j]});
  await seedProfile(extraIds[0]);await seedProfile(extraIds[1]);
  await seedChallenge(extraChallenges[0],extraIds[0],extraSubjects[0]);
  await seedChallenge(extraChallenges[1],extraIds[1],extraSubjects[0]);
  const identityRace=await Promise.all([repository.linkVerifiedAccount(bind(0,0,0)),repository.linkVerifiedAccount(bind(1,0,1))]);
  assert.equal(identityRace.filter(x=>x.ok).length,1,'one provider identity cannot claim two accounts');
  const winner=await createDatabaseActorResolver(sql)({issuer,subject:extraSubjects[0]});
  assert.equal(winner.id,extraIds[identityRace[0].ok?0:1]);
  const loser=identityRace[0].ok?1:0;
  const loserStage=await sql`SELECT ready FROM fam_legacy_migration_profiles WHERE user_id = ${extraIds[loser]};`;
  const loserProof=await sql`SELECT consumed FROM fam_legacy_migration_challenges WHERE challenge_id = ${extraChallenges[loser]};`;
  assert.equal(loserStage[0][0].ready,true);assert.equal(loserProof[0][0].consumed,false);
  await seedProfile(extraIds[2],true,false);
  await seedChallenge(extraChallenges[2],extraIds[2],extraSubjects[1]);
  assert.deepEqual(await repository.linkVerifiedAccount(bind(2,1,2)),fail,'inactive account must remain inactive');
  assert.equal(await createDatabaseActorResolver(sql)({issuer,subject:extraSubjects[1]}),null);
  await seedProfile(extraIds[3]);
  await seedChallenge(extraChallenges[3],extraIds[3],extraSubjects[2]);
  await sql`INSERT INTO fam_account_suspension_open (target_id, school_id, suspension_id, created_at)
    VALUES (${extraIds[3]}, 'lyceum_3', 'synthetic-migration-suspension', CurrentUtcTimestamp());`;
  assert.deepEqual(await repository.linkVerifiedAccount(bind(3,2,3)),fail,'open suspension blocks account linking');
  assert.equal(await createDatabaseActorResolver(sql)({issuer,subject:extraSubjects[2]}),null);
  const deletionGuards=[
    {id:extraIds[4],subject:extraSubjects[3],challenge:extraChallenges[4],request:'synthetic-migration-deletion-pending',status:'pending'},
    {id:extraIds[5],subject:extraSubjects[4],challenge:extraChallenges[5],request:'synthetic-migration-deletion-processing',status:'processing'},
  ];
  for(const guard of deletionGuards){
    await seedProfile(guard.id);await seedChallenge(guard.challenge,guard.id,guard.subject);
    await sql`INSERT INTO fam_account_deletion_requests (request_id,school_id,requester_id,target_id,target_role,reason_code,reason,status,created_at)
      VALUES (${guard.request},'lyceum_3','synthetic-migration-admin',${guard.id},'student','other','synthetic:reason',${guard.status},CurrentUtcTimestamp());`;
    assert.deepEqual(await repository.linkVerifiedAccount({challengeId:guard.challenge,legacyUserId:guard.id,profileVersion:versions.get(guard.id),issuer,subject:guard.subject}),fail,`${guard.status} deletion request blocks account linking`);
    assert.equal((await sql`SELECT ready FROM fam_legacy_migration_profiles WHERE user_id = ${guard.id};`)[0][0].ready,true);
    assert.equal((await sql`SELECT consumed FROM fam_legacy_migration_challenges WHERE challenge_id = ${guard.challenge};`)[0][0].consumed,false);
    assert.equal(await createDatabaseActorResolver(sql)({issuer,subject:guard.subject}),null);
  }
  await seedProfile(extraIds[6]);await seedChallenge(extraChallenges[6],extraIds[6],extraSubjects[5]);
  await sql`INSERT INTO fam_account_deletion_open (target_id,request_id,school_id,created_at)
    VALUES (${extraIds[6]},'synthetic-orphaned-deletion-open','lyceum_3',CurrentUtcTimestamp());`;
  assert.deepEqual(await repository.linkVerifiedAccount(bind(6,5,6)),fail,'open deletion index blocks account linking even without a matching request row');
  assert.equal((await sql`SELECT ready FROM fam_legacy_migration_profiles WHERE user_id = ${extraIds[6]};`)[0][0].ready,true);
  assert.equal((await sql`SELECT consumed FROM fam_legacy_migration_challenges WHERE challenge_id = ${extraChallenges[6]};`)[0][0].consumed,false);
  assert.equal(await createDatabaseActorResolver(sql)({issuer,subject:extraSubjects[5]}),null);
  await stageIntegration(sql,repository,issuer,success,createDatabaseActorResolver);
  console.log('YDB_SYNTHETIC_LEGACY_EXTRA_GUARDS_PASS');
  console.log('YDB_SYNTHETIC_LEGACY_LINK_PASS: UUID preserved, replay and collisions blocked, one concurrent winner, full transaction rollback and retry');
 }finally{await driver.close();}
}
async function stageIntegration(sql,repository,issuer,success,createDatabaseActorResolver){
  const stage=createSyntheticProfileStageRepository(sql);
  const fixture=(id,active=true)=>({id,school_id:'lyceum_3',role:'student',active,first_name:'Synthetic',last_name:'Migration',class_name:'7А',city:null,avatar_url:'',person_type:'student',staff_position:null,staff_verification_status:'not_required'});
  const a=fixture('edededed-eded-4ded-8ded-edededed0010');
  const b=fixture('edededed-eded-4ded-8ded-edededed0011',false);
  const c=fixture('edededed-eded-4ded-8ded-edededed0012');
  const d=fixture('edededed-eded-4ded-8ded-edededed0013');
  const ok=(inserted,unchanged)=>({ok:true,code:'SYNTHETIC_BATCH_STAGED',inserted,unchanged});
  assert.deepEqual(await stage.stageBatch([a,b]),ok(2,0));
  assert.deepEqual(await stage.stageBatch([b,a]),ok(0,2));
  const inactive=await sql`SELECT active, ready, avatar_url, city FROM fam_legacy_migration_profiles WHERE user_id = ${b.id};`;
  assert.equal(inactive[0][0].active,false);assert.equal(inactive[0][0].ready,false);
  assert.equal(inactive[0][0].avatar_url,'');assert.equal(inactive[0][0].city,null);
  assert.deepEqual(await stage.stageBatch([c,{...a,role:'school_admin'}]),{ok:false,code:'STAGING_CONFLICT'});
  assert.equal((await sql`SELECT user_id FROM fam_legacy_migration_profiles WHERE user_id = ${c.id};`)[0].length,0);
  const rollbackSql=(...args)=>sql(...args);
  rollbackSql.begin=callback=>sql.begin(tx=>callback((strings,...values)=>{
    if(strings.join(' ').includes('INSERT INTO fam_legacy_migration_profiles')&&values[0]===d.id)throw Error('synthetic batch failure');
    return tx(strings,...values);
  }));
  assert.deepEqual(await createSyntheticProfileStageRepository(rollbackSql).stageBatch([c,d]),{ok:false,code:'STAGING_UNAVAILABLE'});
  for(const id of [c.id,d.id])assert.equal((await sql`SELECT user_id FROM fam_legacy_migration_profiles WHERE user_id = ${id};`)[0].length,0);
  assert.deepEqual(await stage.stageBatch([c,d]),ok(2,0));
  const version=prepareSyntheticProfileBatch([a]).profiles[0].profile_version;
  const challenge='e'.repeat(64),subject='990000000010';
  await sql`INSERT INTO fam_legacy_migration_challenges (challenge_id,user_id,profile_version,issuer,subject,expires_at,consumed)
    VALUES (${challenge},${a.id},${version},${issuer},${subject},Unwrap(CurrentUtcTimestamp()+Interval('PT4M')),false);`;
  // Mutate individually valid fields while leaving the approved digest and challenge unchanged.
  await sql`UPDATE fam_legacy_migration_profiles SET role = 'school_admin' WHERE user_id = ${a.id};`;
  const input={challengeId:challenge,legacyUserId:a.id,profileVersion:version,issuer,subject};
  assert.deepEqual(await repository.linkVerifiedAccount(input),{ok:false,code:'LINK_UNAVAILABLE'});
  await sql`UPDATE fam_legacy_migration_profiles SET role = 'student', class_name = '8А' WHERE user_id = ${a.id};`;
  assert.deepEqual(await repository.linkVerifiedAccount(input),{ok:false,code:'LINK_UNAVAILABLE'});
  await sql`UPDATE fam_legacy_migration_profiles SET class_name = '7А', avatar_url = CAST(NULL AS Utf8?) WHERE user_id = ${a.id};`;
  assert.deepEqual(await repository.linkVerifiedAccount(input),{ok:false,code:'LINK_UNAVAILABLE'});
  assert.equal((await sql`SELECT user_id FROM fam_user_profiles WHERE user_id = ${a.id};`)[0].length,0);
  assert.equal((await sql`SELECT user_id FROM fam_legacy_migration_links WHERE user_id = ${a.id};`)[0].length,0);
  assert.equal((await sql`SELECT consumed FROM fam_legacy_migration_challenges WHERE challenge_id = ${challenge};`)[0][0].consumed,false);
  assert.equal((await sql`SELECT ready FROM fam_legacy_migration_profiles WHERE user_id = ${a.id};`)[0][0].ready,true);
  await sql`UPDATE fam_legacy_migration_profiles SET avatar_url = '' WHERE user_id = ${a.id};`;
  assert.deepEqual(await repository.linkVerifiedAccount(input),success);
  console.log('YDB_SYNTHETIC_PROFILE_DIGEST_GUARD_PASS: valid role/class/null-empty changes blocked, challenge unconsumed, exact retry succeeds');
  assert.deepEqual(await stage.stageBatch([a]),ok(0,1));
  const final=await sql`SELECT ready FROM fam_legacy_migration_profiles WHERE user_id = ${a.id};`;
  assert.equal(final[0][0].ready,false,'reimport must never reactivate a consumed staged profile');
  assert.equal((await createDatabaseActorResolver(sql)({issuer,subject})).id,a.id);
  console.log('YDB_SYNTHETIC_PROFILE_STAGE_PASS: retry, immutable roles, inactive state, batch rollback and linked profile replay');
}
await main();
