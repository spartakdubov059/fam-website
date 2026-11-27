import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {Driver} from '@ydbjs/core';
import {query} from '@ydbjs/query';
import sharp from 'sharp';
import {createPendingImageStore} from '../app/backend/media/pending-images.mjs';
import {createS3PendingImageStore} from '../app/backend/media/s3-pending-store.mjs';
import {createYdbListingsRepository} from '../app/backend/repositories/ydb-listings.mjs';
import {createDatabaseActorResolver} from '../app/backend/auth/database-actor.mjs';
import {createMediaApi} from '../app/backend/services/media-api.mjs';
import {createYdbLegacyAccountLinkRepository} from './legacy-account-link-ydb.mjs';
import {createSyntheticProfileStageRepository,prepareSyntheticProfileBatch} from './synthetic-profile-stage-ydb.mjs';
// Fixed synthetic fixture: no real avatar URL or file.
// Couples account linking with private image reconciliation and a fresh review.
async function run(){
 const issuer='https://synthetic-avatar.invalid',linkedIssuer='https://login.yandex.ru',school='lyceum_3',other='gymnasium_4';
 const owner='edededed-eded-4ded-8ded-edededed0001',moderator='fefefefe-fefe-4efe-8efe-fefefefe0002',outsider='fefefefe-fefe-4efe-8efe-fefefefe0003';
 const ownerSubject='990000000101';
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const driver=new Driver('grpc://127.0.0.1:2136/local');
 let dir,store;
 try{
  await driver.ready();
  const client=query(driver);
  const sql=(strings,...values)=>{const stmt=client(strings,...values);stmt.on('error',()=>{});return stmt;};
  sql.begin=client.begin.bind(client);
  const repo=createYdbListingsRepository(sql),resolveActor=createDatabaseActorResolver(sql);
  for(const [id,scope,role] of [[owner,school,'student'],[moderator,school,'school_admin'],[outsider,other,'school_admin']]){
   assert.equal((await sql`SELECT user_id FROM fam_user_profiles WHERE user_id = ${id};`)[0].length,0);
   if(id===owner)continue; // Created only by the verified legacy-account link below.
   await sql`INSERT INTO fam_user_profiles (issuer,subject,user_id,school_id,role,active,avatar_url)
      VALUES (${issuer},${id},${id},${scope},${role},true,'');`;
  }
  const oldObjects=new Map(),targetObjects=new Map();
  const sourceStore=createPendingImageStore({sharp,bucket:'synthetic-old-private',putObject:async input=>{
   assert.equal(input.ServerSideEncryption,'AES256');assert.equal(input.ContentType,'image/webp');
   oldObjects.set(input.Key,Buffer.from(input.Body));
  }});
  const image=await sharp({create:{width:48,height:32,channels:3,background:'#336699'}}).jpeg().toBuffer();
  const source=await sourceStore.put({userId:owner,bytes:image,contentType:'image/jpeg'});
  const original=oldObjects.get(source.key),expectedHash=hash(original),expectedSize=original.length;
  assert.equal((await sharp(original).metadata()).format,'webp');
  const legacyProfile={id:owner,school_id:school,role:'student',active:true,first_name:'Synthetic',last_name:'Migration',class_name:'7А',city:null,
   avatar_url:'https://legacy.invalid/private/'+source.key,person_type:'student',staff_position:null,staff_verification_status:'not_required'};
  assert.equal(prepareSyntheticProfileBatch([legacyProfile]).code,'AVATAR_RECONCILIATION_REQUIRED',
   'an old avatar URL cannot be discarded before its private bytes are reconciled');
  dir=await mkdtemp(join(tmpdir(),'fam-ru-avatar-rehearsal-'));
  const archivePath=join(dir,'synthetic-avatar.webp');
  await writeFile(archivePath,original,{flag:'wx',mode:0o600});
  const targetKey='pending/'+owner+'/fefefefe-fefe-4efe-8efe-fefefefe0101.webp';
  store=createS3PendingImageStore({FAM_RU_S3_ENDPOINT:'http://127.0.0.1:9000',FAM_RU_S3_BUCKET:'synthetic-target-private',FAM_RU_S3_ACCESS_KEY_ID:'synthetic-access',FAM_RU_S3_SECRET_ACCESS_KEY:'synthetic-secret'},{
   send:async()=>{throw Error('unexpected upload');},
   get:async input=>{
    assert.equal(input.Bucket,'synthetic-target-private');
    const bytes=targetObjects.get(input.Key);
    if(!bytes)throw Error('synthetic object missing');
    return {ContentType:'image/webp',ContentLength:bytes.length,Body:Readable.from([bytes])};
   },
   remove:async()=>{throw Error('unexpected deletion');},
   list:async()=>({Contents:[],IsTruncated:false})
  });
  async function stage(){
   const bytes=await readFile(archivePath);
   if(bytes.length!==expectedSize||hash(bytes)!==expectedHash)throw Error('SYNTHETIC_AVATAR_BYTES_MISMATCH');
   assert.equal((await sharp(bytes,{failOn:'error',limitInputPixels:100000}).metadata()).format,'webp');
   const existing=targetObjects.get(targetKey);
   if(existing&&!existing.equals(bytes))throw Error('SYNTHETIC_AVATAR_TARGET_CONFLICT');
   if(!existing)targetObjects.set(targetKey,Buffer.from(bytes));
   const readback=await store.get(targetKey);
   if(readback.length!==expectedSize||hash(readback)!==expectedHash)throw Error('SYNTHETIC_AVATAR_READBACK_MISMATCH');
  }
  await unlink(archivePath);
  await assert.rejects(stage);
  assert.equal(targetObjects.size,0);
  const corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;
  await writeFile(archivePath,corrupt,{flag:'wx',mode:0o600});
  await assert.rejects(stage,/SYNTHETIC_AVATAR_BYTES_MISMATCH/);
  assert.equal(targetObjects.size,0);
  await writeFile(archivePath,original);
  await stage();await stage();assert.equal(targetObjects.size,1);
  targetObjects.set(targetKey,corrupt);
  await assert.rejects(stage,/SYNTHETIC_AVATAR_TARGET_CONFLICT/);
  assert.deepEqual(targetObjects.get(targetKey),corrupt);
  targetObjects.set(targetKey,Buffer.from(original));
  await stage();
  assert.equal((await sql`SELECT object_key FROM fam_pending_media WHERE user_id = ${owner};`)[0].length,0,
   'copied private bytes are not registered while the legacy account is unlinked');
  assert.equal(await resolveActor({issuer:linkedIssuer,subject:ownerSubject}),null,
   'the legacy UUID has no Yandex actor until account ownership is proven');
  const migratedProfile={...legacyProfile,avatar_url:''};
  const prepared=prepareSyntheticProfileBatch([migratedProfile]);
  assert.equal(prepared.ok,true);
  const profileStage=createSyntheticProfileStageRepository(sql);
  assert.deepEqual(await profileStage.stageBatch([migratedProfile]),{ok:true,code:'SYNTHETIC_BATCH_STAGED',inserted:1,unchanged:0});
  const challengeId='a'.repeat(64),profileVersion=prepared.profiles[0].profile_version;
  await sql`INSERT INTO fam_legacy_migration_challenges
    (challenge_id,user_id,profile_version,issuer,subject,expires_at,consumed)
    VALUES (${challengeId},${owner},${profileVersion},${linkedIssuer},${ownerSubject},
      Unwrap(CurrentUtcTimestamp()+Interval('PT4M')),false);`;
  assert.deepEqual(await createYdbLegacyAccountLinkRepository(sql).linkVerifiedAccount({
   challengeId,legacyUserId:owner,profileVersion,issuer:linkedIssuer,subject:ownerSubject,
  }),{ok:true,code:'LINKED'});
  assert.equal((await resolveActor({issuer:linkedIssuer,subject:ownerSubject})).id,owner,
   'verified linking preserves the original UUID');
  // A valid private copy becomes reviewable only after the original account is linked.
  await repo.registerPendingImage(owner,targetKey);
  assert.equal(await repo.createAvatarReview({userId:outsider,schoolId:other,imageKey:targetKey}),null);
  const review=await repo.createAvatarReview({userId:owner,schoolId:school,imageKey:targetKey});
  assert.equal(review.status,'pending');
  assert.equal(await repo.createAvatarReview({userId:owner,schoolId:school,imageKey:targetKey}),null);
  assert.equal((await resolveActor({issuer:linkedIssuer,subject:ownerSubject})).avatar_url,'');
  assert.equal(await repo.isCurrentAvatar(review.id),false);
  assert.equal((await repo.listPendingAvatarReviews(other)).some(row=>row.id===review.id),false);
  const identities=new Map([
   [owner,{issuer:linkedIssuer,subject:ownerSubject}],
   [moderator,{issuer,subject:moderator}],
   [outsider,{issuer,subject:outsider}],
  ]);
  const authenticate=async req=>identities.get(req.headers.authorization)??null;
  const api=createMediaApi({authenticate,resolveActor,repository:repo,pendingImages:store});
  const url='/api/v1/avatars/'+review.id+'/photo';
  const get=id=>api({method:'GET',url,headers:{authorization:id}});
  assert.equal((await get('')).status,401);
  assert.equal((await get(owner)).status,403);
  assert.equal((await get(outsider)).status,403);
  const pending=await get(moderator);
  assert.equal(pending.status,200);assert.equal(hash(pending.body),expectedHash);
  assert.equal(pending.headers['cache-control'],'private, no-store');
  assert.equal(await repo.moderateAvatarReview(review.id,school,outsider,'approved'),false);
  assert.equal(await repo.moderateAvatarReview(review.id,school,owner,'approved'),false);
  assert.equal(await repo.isCurrentAvatar(review.id),false);
  assert.equal(await repo.moderateAvatarReview(review.id,school,moderator,'approved'),true);
  assert.equal((await resolveActor({issuer:linkedIssuer,subject:ownerSubject})).avatar_url,url);
  assert.equal(await repo.isCurrentAvatar(review.id),true);
  assert.equal((await get('')).status,404);
  assert.equal((await get(outsider)).status,404);
  assert.equal((await get(moderator)).status,404);
  const restored=await get(owner);
  assert.equal(restored.status,200);assert.equal(restored.headers['content-type'],'image/webp');
  assert.equal(hash(restored.body),expectedHash);assert.deepEqual(restored.body,original);
  assert.equal((await sharp(restored.body).metadata()).format,'webp');
  targetObjects.delete(targetKey);
  assert.equal((await get(owner)).status,404);
  console.log('YDB_SYNTHETIC_AVATAR_REHEARSAL_PASS: private copy, verified legacy UUID link before media registration, fresh review, corruption refusal, no auto-approval, school and owner access');
 }finally{
  store?.close();
  try{if(dir)await rm(dir,{recursive:true,force:true});}finally{await driver.close();}
 }
}
await run();
