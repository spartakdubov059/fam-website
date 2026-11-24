import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createDatabaseActorResolver } from '../app/backend/auth/database-actor.mjs';
import { createYdbLegacyAccountLinkRepository } from './legacy-account-link-ydb.mjs';
async function main(){
 const driver=new Driver('grpc://127.0.0.1:2136/local');
 try{
  await driver.ready();
  const client=query(driver);
  const sql=(strings,...values)=>{const stmt=client(strings,...values);stmt.on('error',()=>{});return stmt;};
  sql.begin=client.begin.bind(client);
  const repository=createYdbLegacyAccountLinkRepository(sql);
  const issuer='https://login.yandex.ru',version='d'.repeat(64);
  const ids=['edededed-eded-4ded-8ded-ededededed01','edededed-eded-4ded-8ded-ededededed02','edededed-eded-4ded-8ded-ededededed03','edededed-eded-4ded-8ded-ededededed04'];
  const subjects=['990000000001','990000000002','990000000003','990000000004','990000000005'];
  const challenges=['1','2','3','4','5','6'].map(c=>c.repeat(64));
  const seedProfile=async(id,ready=true,active=true)=>{
   await sql`INSERT INTO fam_legacy_migration_profiles (user_id, profile_version, ready, school_id, role, active, first_name, last_name, class_name, person_type, staff_verification_status)
    VALUES (${id}, ${version}, ${ready}, 'lyceum_3', 'student', ${active}, 'Synthetic', 'Migration', '7А', 'student', 'not_required');`;
  };
  const seedChallenge=async(challengeId,userId,subject,expired=false)=>{
   if(expired)await sql`INSERT INTO fam_legacy_migration_challenges (challenge_id, user_id, profile_version, issuer, subject, expires_at, consumed)
     VALUES (${challengeId}, ${userId}, ${version}, ${issuer}, ${subject}, CurrentUtcTimestamp() - Interval("PT1M"), false);`;
   else await sql`INSERT INTO fam_legacy_migration_challenges (challenge_id, user_id, profile_version, issuer, subject, expires_at, consumed)
     VALUES (${challengeId}, ${userId}, ${version}, ${issuer}, ${subject}, CurrentUtcTimestamp() + Interval("PT4M"), false);`;
  };
  const input=(i,j,k)=>({challengeId:challenges[k],legacyUserId:ids[i],profileVersion:version,issuer,subject:subjects[j]});
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
  console.log('YDB_SYNTHETIC_LEGACY_LINK_PASS: UUID preserved, replay and collisions blocked, one concurrent winner, full transaction rollback and retry');
 }finally{await driver.close();}
}
await main();
