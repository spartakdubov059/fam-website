import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifySyntheticAttachmentReconciliation} from './verify-synthetic-attachment-reconciliation.mjs';
import {Driver} from '@ydbjs/core';
import {query} from '@ydbjs/query';
import {encodeSyntheticStateBackup,decodeSyntheticStateBackup,verifySyntheticStateAcceptance} from './synthetic-state-backup-envelope.mjs';
// Hard-coded loopback database and synthetic fixture. No production route or importer.
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function makeFixture(){
 const a='synthetic-restore-owner',b='synthetic-restore-member',s='synthetic-restore-school',l='synthetic-restore-listing';
 const created_at='2026-11-24T12:00:00.000Z';
 const pulseStart='2099-11-24T12:00:00.000Z',pulseEnd='2099-11-25T12:00:00.000Z';
 const accounts=[{user_id:a,school_id:s,role:'council_member',active:true},{user_id:b,school_id:s,role:'student',active:false}];
 const content={profiles:accounts.map(({user_id,school_id})=>({user_id,school_id})),listings:[{id:l,user_id:a,school_id:s,image_key:'synthetic-restore-listing-image'}],ideas:[{id:'synthetic-restore-idea',user_id:b,school_id:s}],messages:[{id:'synthetic-restore-message',sender_id:b,receiver_id:a,school_id:s,listing_id:l}],pending_messages:[{id:'synthetic-restore-pending',sender_id:a,receiver_id:b,school_id:s,listing_id:l}],favorites:[{user_id:b,listing_id:l}],media:[{object_key:'synthetic-restore-listing-image',user_id:a},{object_key:'synthetic-restore-idea-image',user_id:b},{object_key:'synthetic-restore-idea-image-2',user_id:b}],idea_images:[{idea_id:'synthetic-restore-idea',image_index:0,object_key:'synthetic-restore-idea-image',user_id:b,school_id:s},{idea_id:'synthetic-restore-idea',image_index:1,object_key:'synthetic-restore-idea-image-2',user_id:b,school_id:s}]};
 const payloads={listings:[{id:l,title:'synthetic:restore event',description:'synthetic:restore description',created_at}],ideas:[{id:content.ideas[0].id,body:'synthetic:restore idea',created_at}],messages:[{id:content.messages[0].id,body:'synthetic:approved body',created_at}],pending_messages:[{id:content.pending_messages[0].id,body:'synthetic:pending body',created_at}]};
 const activity={listing_event_fields:[{id:l,is_event:true,event_date:'2026-11-25',event_time:'10:00',event_type:'limited',max_seats:1}],event_registrations:[{event_id:l,user_id:b,school_id:s,status:'confirmed',created_at}],event_occupancy:[{event_id:l,taken:1}],announcements:[{announcement_id:'synthetic-restore-news',school_id:s,author_id:a,title:'synthetic:notice',body:'synthetic:notice text',kind:'news',event_starts_at:null,published_at:pulseStart,expires_at:pulseEnd}],polls:[{poll_id:'synthetic-restore-poll',school_id:s,author_id:a,question:'synthetic:question',options:['synthetic:yes','synthetic:no'],created_at:pulseStart,closes_at:pulseEnd}],votes:[{poll_id:'synthetic-restore-poll',voter_id:b,school_id:s,choice_index:1,created_at:pulseStart}]};
 const files=content.media.map(row=>({object_key:row.object_key,bytes:Buffer.from('synthetic:'+row.object_key)}));
 const objects=content.media.map((row,index)=>({...row,byte_length:files[index].bytes.length,sha256:hash(files[index].bytes)}));
 const state={listings:[{id:l,category:'Мероприятия',price_text:'Бесплатно',status:'active',photo_status:'approved'}],
  ideas:[{id:content.ideas[0].id,image_status:'pending',ai_status:'pending',ai_summary:'',ai_reason:'synthetic:review',admin_status:'new'}],
  messages:[{id:content.messages[0].id,is_read:true}],
  favorites:content.favorites.map(row=>({...row,created_at:'2026-11-24T13:00:00.000Z'})),
  media:content.media.map(({object_key})=>({object_key,status:'linked',claim_token:'',created_at:'2026-11-24T11:00:00.000Z',claim_until:'2026-11-24T11:00:01.000Z'})),
  idea_images:content.idea_images.map(({idea_id,image_index})=>({idea_id,image_index,created_at:'2026-11-24T12:00:01.000Z'}))};
 return {snapshot:{snapshot_id:'synthetic-restore-batch',accounts,content,objects,payloads,activity},files,state};
}
async function run(){
 const driver=new Driver('grpc://127.0.0.1:2136/local');
 let dir;
 try{
  await driver.ready();
  const client=query(driver);
  const sql=(strings,...values)=>{const stmt=client(strings,...values);stmt.on('error',()=>{});return stmt;};
  sql.begin=client.begin.bind(client);
  const {snapshot:source,files,state}=makeFixture(),archive=encodeSyntheticStateBackup(source,files,state);
  assert.equal(archive.ok,true);
  const decoded=decodeSyntheticStateBackup(archive.bytes,archive.sha256);
  assert.equal(decoded.ok,true);
  const snap=decoded.snapshot,storedState=decoded.state;
  const [listingState]=storedState.listings,[ideaState]=storedState.ideas,[messageState]=storedState.messages,[favoriteState]=storedState.favorites;
  const mediaStates=new Map(storedState.media.map(row=>[row.object_key,row]));
  const imageStates=new Map(storedState.idea_images.map(row=>[JSON.stringify([row.idea_id,row.image_index]),row]));
  dir=await mkdtemp(join(tmpdir(),'fam-ru-disposable-media-'));
  // Only decoded, validated synthetic keys are used as file names. Exclusive writes; never overwrite.
  for(const file of decoded.objects)await writeFile(join(dir,file.object_key),file.bytes,{mode:0o600,flag:'wx'});
  const inventory=async owners=>{
   const names=await readdir(dir);
   const expected=new Map(owners.map(row=>[row.object_key,row.user_id]));
   assert.deepEqual(names.sort(),[...expected.keys()].sort(),'attachment inventory mismatch');
   return Promise.all(names.map(async object_key=>{const bytes=await readFile(join(dir,object_key));return {object_key,user_id:expected.get(object_key),byte_length:bytes.length,sha256:hash(bytes)};}));
  };
  const verifyFiles=async()=>{
   const targetObjects=await inventory(snap.content.media);
   const result=verifySyntheticAttachmentReconciliation({expectedMedia:snap.content.media,sourceObjects:snap.objects,targetObjects});
   assert.equal(result.ok,true,JSON.stringify(result));
  };
  const [listing]=snap.content.listings,[payload]=snap.payloads.listings,[event]=snap.activity.listing_event_fields;
  const [reg]=snap.activity.event_registrations,[occupancy]=snap.activity.event_occupancy;
  const [approved]=snap.content.messages,[pending]=snap.content.pending_messages;
  const [approvedPayload]=snap.payloads.messages,[pendingPayload]=snap.payloads.pending_messages;
  const school=listing.school_id,issuer='https://synthetic.invalid';
  const [idea]=snap.content.ideas,[ideaPayload]=snap.payloads.ideas,[favorite]=snap.content.favorites;
  const [announcement]=snap.activity.announcements,[poll]=snap.activity.polls,[vote]=snap.activity.votes;
  // This is an intentionally fixed fixture, not an arbitrary import API. Never consume an external archive.
  // Fixed fixture: explicit coverage and no external input.
  assert.equal(snap.content.media.length,3);assert.equal(snap.objects.length,3);
  assert.equal(snap.content.idea_images.length,2);
  for(const rows of [snap.content.listings,snap.content.messages,snap.content.pending_messages,snap.activity.listing_event_fields,snap.activity.event_registrations,snap.activity.event_occupancy,snap.content.ideas,snap.content.favorites,snap.activity.announcements,snap.activity.polls,snap.activity.votes])assert.equal(rows.length,1);
  const read=async tx=>{
   const profiles=(await tx`SELECT issuer, subject, user_id, school_id, role, active FROM fam_user_profiles WHERE school_id = ${school};`)[0];
   const listings=(await tx`SELECT id,user_id,school_id,image_key,title,description,created_at,is_event,event_date,event_time,event_type,max_seats,category,price_text,photo_status,status FROM fam_listings WHERE id = ${listing.id};`)[0];
   const messages=(await tx`SELECT id,sender_id,receiver_id,school_id,listing_id,body,created_at,is_read FROM fam_messages WHERE listing_id = ${listing.id};`)[0];
   const pendingMessages=(await tx`SELECT id,sender_id,receiver_id,school_id,listing_id,body,created_at FROM fam_pending_messages WHERE listing_id = ${listing.id};`)[0];
   const registrations=(await tx`SELECT event_id,user_id,school_id,status,created_at FROM fam_event_registrations WHERE event_id = ${listing.id};`)[0];
   const occupancies=(await tx`SELECT event_id,taken FROM fam_event_occupancy WHERE event_id = ${listing.id};`)[0];
   const ideas=(await tx`SELECT id,user_id,school_id,text,created_at,image_status,ai_status,ai_summary,ai_reason,admin_status FROM fam_ideas WHERE school_id = ${school};`)[0];
   const favorites=(await tx`SELECT user_id,listing_id,created_at FROM fam_favorites WHERE listing_id = ${listing.id};`)[0];
   const announcements=(await tx`SELECT announcement_id,school_id,author_id,title,body,kind,event_starts_at,published_at,expires_at FROM fam_school_announcements WHERE school_id = ${school};`)[0];
   const polls=(await tx`SELECT poll_id,school_id,author_id,question,options_json,closes_at,created_at FROM fam_school_polls WHERE school_id = ${school};`)[0];
   const votes=(await tx`SELECT poll_id,voter_id,school_id,choice_index,created_at FROM fam_school_poll_votes WHERE poll_id = ${poll.poll_id};`)[0];
   const media=(await tx`SELECT object_key,user_id,created_at,status,claim_token,claim_until FROM fam_pending_media WHERE user_id = ${listing.user_id} OR user_id = ${idea.user_id};`)[0];
   const ideaImages=(await tx`SELECT idea_id,image_index,object_key,user_id,school_id,created_at FROM fam_idea_images WHERE idea_id = ${idea.id};`)[0];
   return {profiles,listings,messages,pendingMessages,registrations,occupancies,ideas,favorites,announcements,polls,votes,media,ideaImages};
  };
  const empty=rows=>Object.values(rows).every(list=>list.length===0);
  const asIso=value=>new Date(value).toISOString();
  const pick=(row,keys)=>Object.fromEntries(keys.map(k=>[k,row[k]]));
  const messageFields=['id','sender_id','receiver_id','school_id','listing_id'];
  async function readSnapshot(rows){
   const accounts=rows.profiles.map(x=>pick(x,['issuer','subject','user_id','school_id','role','active']));
   const content={profiles:accounts.map(x=>pick(x,['user_id','school_id'])),
    listings:rows.listings.map(x=>pick(x,['id','user_id','school_id','image_key'])),
    ideas:rows.ideas.map(x=>pick(x,['id','user_id','school_id'])),messages:rows.messages.map(x=>pick(x,messageFields)),pending_messages:rows.pendingMessages.map(x=>pick(x,messageFields)),favorites:rows.favorites.map(x=>pick(x,['user_id','listing_id'])),media:rows.media.map(x=>pick(x,['object_key','user_id'])),idea_images:rows.ideaImages.map(x=>({...pick(x,['idea_id','object_key','user_id','school_id']),image_index:Number(x.image_index)}))};
   const payloads={listings:rows.listings.map(x=>({...pick(x,['id','title','description']),created_at:asIso(x.created_at)})),ideas:rows.ideas.map(x=>({id:x.id,body:x.text,created_at:asIso(x.created_at)})),
    messages:rows.messages.map(x=>({...pick(x,['id','body']),created_at:asIso(x.created_at)})),
    pending_messages:rows.pendingMessages.map(x=>({...pick(x,['id','body']),created_at:asIso(x.created_at)}))};
   const activity={listing_event_fields:rows.listings.map(x=>({...pick(x,['id','is_event','event_date','event_time','event_type']),max_seats:Number(x.max_seats)})),
    event_registrations:rows.registrations.map(x=>({...pick(x,['event_id','user_id','school_id','status']),created_at:asIso(x.created_at)})),
    event_occupancy:rows.occupancies.map(x=>({event_id:x.event_id,taken:Number(x.taken)})),
    announcements:rows.announcements.map(x=>({...pick(x,['announcement_id','school_id','author_id','title','body','kind']),event_starts_at:x.event_starts_at==null?null:asIso(x.event_starts_at),published_at:asIso(x.published_at),expires_at:asIso(x.expires_at)})),
    polls:rows.polls.map(x=>({...pick(x,['poll_id','school_id','author_id','question']),options:JSON.parse(x.options_json),closes_at:asIso(x.closes_at),created_at:asIso(x.created_at)})),
    votes:rows.votes.map(x=>({...pick(x,['poll_id','voter_id','school_id']),choice_index:Number(x.choice_index),created_at:asIso(x.created_at)}))};
   return {snapshot_id:snap.snapshot_id,accounts,content,payloads,activity,objects:await inventory(content.media)};
  }
  const assertMatch=async rows=>{
   const restored=await readSnapshot(rows);
   const restoredSource={...restored,accounts:restored.accounts.map(({issuer,subject,...row})=>row)};
   const actualState={
    listings:rows.listings.map(x=>pick(x,['id','category','price_text','status','photo_status'])),
    ideas:rows.ideas.map(x=>pick(x,['id','image_status','ai_status','ai_summary','ai_reason','admin_status'])),
    messages:rows.messages.map(x=>pick(x,['id','is_read'])),
    favorites:rows.favorites.map(x=>({...pick(x,['user_id','listing_id']),created_at:asIso(x.created_at)})),
    media:rows.media.map(x=>({...pick(x,['object_key','status','claim_token']),created_at:asIso(x.created_at),claim_until:asIso(x.claim_until)})),
    idea_images:rows.ideaImages.map(x=>({idea_id:x.idea_id,image_index:Number(x.image_index),created_at:asIso(x.created_at)}))
   };
   const result=verifySyntheticStateAcceptance({source:{snapshot:snap,state:storedState},target:{snapshot:restored,state:actualState},restored:{snapshot:restoredSource,state:actualState}});
   assert.equal(result.ok,true,JSON.stringify(result));
   for(const row of rows.profiles){assert.equal(row.issuer,issuer);assert.equal(row.subject,row.user_id);}
  };
  async function restore(injectFailure=false){
   // Files are a private, local staging area. No database references until all bytes match.
   // This does not imply a distributed transaction with a remote object store.
   await verifyFiles();
   return sql.begin(async tx=>{
    const before=await read(tx);
    if(!empty(before)){
     await assertMatch(before);
     return 'unchanged';
    }
    for(const a of snap.accounts){
     // Reject any cross-school UUID collision even with a different provider key.
     assert.equal((await tx`SELECT user_id FROM fam_user_profiles WHERE user_id = ${a.user_id} LIMIT 1;`)[0].length,0);
     await tx`INSERT INTO fam_user_profiles (issuer,subject,user_id,school_id,role,active,person_type,staff_verification_status)
       VALUES (${issuer},${a.user_id},${a.user_id},${a.school_id},${a.role},${a.active},'student','not_required');`;
    }
    await tx`INSERT INTO fam_listings (id,user_id,school_id,title,description,category,price_text,is_event,event_date,event_time,event_type,max_seats,image_key,photo_status,status,created_at)
      VALUES (${listing.id},${listing.user_id},${school},${payload.title},${payload.description},${listingState.category},${listingState.price_text},${event.is_event},${event.event_date},${event.event_time},${event.event_type},Unwrap(CAST(${event.max_seats} AS Uint32)),${listing.image_key},${listingState.photo_status},${listingState.status},Unwrap(CAST(${payload.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_messages (id,sender_id,receiver_id,school_id,listing_id,body,is_read,created_at)
      VALUES (${approved.id},${approved.sender_id},${approved.receiver_id},${approved.school_id},${approved.listing_id},${approvedPayload.body},${messageState.is_read},Unwrap(CAST(${approvedPayload.created_at} AS Timestamp)));`;
    
    await tx`INSERT INTO fam_pending_messages (id,sender_id,receiver_id,school_id,listing_id,body,created_at)
      VALUES (${pending.id},${pending.sender_id},${pending.receiver_id},${pending.school_id},${pending.listing_id},${pendingPayload.body},Unwrap(CAST(${pendingPayload.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_event_registrations (event_id,user_id,school_id,status,created_at)
      VALUES (${reg.event_id},${reg.user_id},${reg.school_id},${reg.status},Unwrap(CAST(${reg.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_event_occupancy (event_id,taken) VALUES (${occupancy.event_id},Unwrap(CAST(${occupancy.taken} AS Uint32)));`;
    await tx`INSERT INTO fam_ideas (id,user_id,school_id,text,image_status,ai_status,ai_summary,ai_reason,admin_status,created_at)
      VALUES (${idea.id},${idea.user_id},${idea.school_id},${ideaPayload.body},${ideaState.image_status},${ideaState.ai_status},${ideaState.ai_summary},${ideaState.ai_reason},${ideaState.admin_status},Unwrap(CAST(${ideaPayload.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_favorites (user_id,listing_id,created_at)
      VALUES (${favorite.user_id},${favorite.listing_id},Unwrap(CAST(${favoriteState.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_school_announcements (announcement_id,school_id,author_id,title,body,kind,event_starts_at,published_at,expires_at)
      VALUES (${announcement.announcement_id},${announcement.school_id},${announcement.author_id},${announcement.title},${announcement.body},${announcement.kind},CAST(NULL AS Timestamp?),Unwrap(CAST(${announcement.published_at} AS Timestamp)),Unwrap(CAST(${announcement.expires_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_school_polls (poll_id,school_id,author_id,question,options_json,closes_at,created_at)
      VALUES (${poll.poll_id},${poll.school_id},${poll.author_id},${poll.question},${JSON.stringify(poll.options)},Unwrap(CAST(${poll.closes_at} AS Timestamp)),Unwrap(CAST(${poll.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_school_poll_votes (poll_id,voter_id,school_id,choice_index,created_at)
      VALUES (${vote.poll_id},${vote.voter_id},${vote.school_id},Unwrap(CAST(${vote.choice_index} AS Uint32)),Unwrap(CAST(${vote.created_at} AS Timestamp)));`;
    for(const media of snap.content.media){
     const detail=mediaStates.get(media.object_key);
     await tx`INSERT INTO fam_pending_media (object_key,user_id,created_at,status,claim_token,claim_until)
       VALUES (${media.object_key},${media.user_id},Unwrap(CAST(${detail.created_at} AS Timestamp)),${detail.status},${detail.claim_token},Unwrap(CAST(${detail.claim_until} AS Timestamp)));`;
    }
    for(const image of snap.content.idea_images){
     const detail=imageStates.get(JSON.stringify([image.idea_id,image.image_index]));
     await tx`INSERT INTO fam_idea_images (idea_id,image_index,object_key,user_id,school_id,created_at)
       VALUES (${image.idea_id},Unwrap(CAST(${image.image_index} AS Uint32)),${image.object_key},${image.user_id},${image.school_id},Unwrap(CAST(${detail.created_at} AS Timestamp)));`;
    }
    if(injectFailure)throw Error('synthetic restore interruption');
    await assertMatch(await read(tx));
    return 'restored';
   });
  }
  assert.equal(empty(await read(sql)),true);
  const first=decoded.objects[0],firstPath=join(dir,first.object_key);
  await unlink(firstPath);
  await assert.rejects(()=>restore(),/attachment inventory mismatch/);
  assert.equal(empty(await read(sql)),true,'missing file blocks all database writes');
  await writeFile(firstPath,first.bytes,{mode:0o600,flag:'wx'});
  const corrupted=Buffer.from(first.bytes);corrupted[corrupted.length-1]^=1;
  await writeFile(firstPath,corrupted);
  await assert.rejects(()=>restore(),/ATTACHMENT_BYTES_MISMATCH/);
  assert.equal(empty(await read(sql)),true,'corrupt file blocks all database writes');
  await writeFile(firstPath,first.bytes);
  // SDK wraps a transaction callback failure in Error("Transaction failed.") with its original cause.
  // Verify the exact cause, not merely any rejected transaction.
  await assert.rejects(()=>restore(true),error=>error?.message==='Transaction failed.'&&error.cause?.message==='synthetic restore interruption');
  assert.equal(empty(await read(sql)),true,'interrupted restore must leave all thirteen tables unchanged');
  assert.equal(await restore(),'restored');
  await assertMatch(await read(sql));
  assert.equal(await restore(),'unchanged','exact replay must not duplicate records');
  await sql`UPDATE fam_pending_messages SET body = 'synthetic:changed' WHERE id = ${pending.id};`;
  await assert.rejects(()=>restore(),error=>error?.message==='Transaction failed.'&&error.cause?.code==='ERR_ASSERTION'&&/PAYLOAD_MISMATCH/.test(error.cause.message));
  const altered=await read(sql);
  assert.equal(altered.pendingMessages[0].body,'synthetic:changed','conflicting replay cannot overwrite existing rows');
  assert.equal(altered.messages[0].body,approvedPayload.body);
  await sql`UPDATE fam_pending_messages SET body = ${pendingPayload.body} WHERE id = ${pending.id};`;
  await assertMatch(await read(sql));
  await sql`UPDATE fam_school_poll_votes SET choice_index=Unwrap(CAST(0 AS Uint32)) WHERE poll_id = ${vote.poll_id} AND voter_id = ${vote.voter_id};`;
  await assert.rejects(()=>restore(),error=>error?.message==='Transaction failed.'&&error.cause?.code==='ERR_ASSERTION'&&/ACTIVITY_MISMATCH/.test(error.cause.message));
  assert.equal(Number((await read(sql)).votes[0].choice_index),0,'a conflicting vote must not be silently overwritten');
  await sql`UPDATE fam_school_poll_votes SET choice_index=Unwrap(CAST(${vote.choice_index} AS Uint32)) WHERE poll_id = ${vote.poll_id} AND voter_id = ${vote.voter_id};`;
  await assertMatch(await read(sql));
  // Replays must not accept changed object ownership, moderation state, or modified bytes.
  await sql`UPDATE fam_ideas SET image_status = 'approved' WHERE id = ${idea.id};`;
  await assert.rejects(()=>restore(),error=>error?.message==='Transaction failed.'&&error.cause?.code==='ERR_ASSERTION'&&/RECORD_STATE_MISMATCH/.test(error.cause.message));
  assert.equal((await read(sql)).ideas[0].image_status,'approved','replay must not silently overwrite moderation state');
  await sql`UPDATE fam_ideas SET image_status = 'pending' WHERE id = ${idea.id};`;
  await sql`UPDATE fam_messages SET is_read = false WHERE id = ${approved.id};`;
  await assert.rejects(()=>restore(),error=>error?.message==='Transaction failed.'&&error.cause?.code==='ERR_ASSERTION'&&/RECORD_STATE_MISMATCH/.test(error.cause.message));
  assert.equal((await read(sql)).messages[0].is_read,false,'replay cannot overwrite read flags');
  await sql`UPDATE fam_messages SET is_read = ${messageState.is_read} WHERE id = ${approved.id};`;
  await writeFile(firstPath,corrupted);
  await assert.rejects(()=>restore(),/ATTACHMENT_BYTES_MISMATCH/);
  assert.equal((await read(sql)).media.length,3);
  await writeFile(firstPath,first.bytes);
  await assertMatch(await read(sql));
  console.log('YDB_SYNTHETIC_RESTORE_PASS: thirteen actual tables, local file byte reconciliation, missing and corrupt object rejection, atomic DB rollback, replay and moderation conflict refusal');
 }finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{await driver.close();}}
}
await run();
