import assert from 'node:assert/strict';
import {Driver} from '@ydbjs/core';
import {query} from '@ydbjs/query';
import {encodeSyntheticFullBackup,decodeSyntheticFullBackup} from './synthetic-full-backup-envelope.mjs';
import {verifySyntheticMigrationAcceptance} from './verify-synthetic-migration-acceptance.mjs';
// Hard-coded loopback database and synthetic fixture. No production route or importer.
function makeFixture(){
 const a='synthetic-restore-owner',b='synthetic-restore-member',s='synthetic-restore-school',l='synthetic-restore-listing';
 const created_at='2026-11-24T12:00:00.000Z';
 const accounts=[{user_id:a,school_id:s,role:'council_member',active:true},{user_id:b,school_id:s,role:'student',active:false}];
 const content={profiles:accounts.map(({user_id,school_id})=>({user_id,school_id})),listings:[{id:l,user_id:a,school_id:s,image_key:''}],ideas:[],messages:[{id:'synthetic-restore-message',sender_id:b,receiver_id:a,school_id:s,listing_id:l}],pending_messages:[{id:'synthetic-restore-pending',sender_id:a,receiver_id:b,school_id:s,listing_id:l}],favorites:[],media:[],idea_images:[]};
 const payloads={listings:[{id:l,title:'synthetic:restore event',description:'synthetic:restore description',created_at}],ideas:[],messages:[{id:content.messages[0].id,body:'synthetic:approved body',created_at}],pending_messages:[{id:content.pending_messages[0].id,body:'synthetic:pending body',created_at}]};
 const activity={listing_event_fields:[{id:l,is_event:true,event_date:'2026-11-25',event_time:'10:00',event_type:'limited',max_seats:1}],event_registrations:[{event_id:l,user_id:b,school_id:s,status:'confirmed',created_at}],event_occupancy:[{event_id:l,taken:1}],announcements:[],polls:[],votes:[]};
 return {snapshot_id:'synthetic-restore-batch',accounts,content,objects:[],payloads,activity};
}
async function run(){
 const driver=new Driver('grpc://127.0.0.1:2136/local');
 try{
  await driver.ready();
  const client=query(driver);
  const sql=(strings,...values)=>{const stmt=client(strings,...values);stmt.on('error',()=>{});return stmt;};
  sql.begin=client.begin.bind(client);
  const source=makeFixture(),archive=encodeSyntheticFullBackup(source,[]);
  assert.equal(archive.ok,true);
  const decoded=decodeSyntheticFullBackup(archive.bytes,archive.sha256);
  assert.equal(decoded.ok,true);
  const snap=decoded.snapshot;
  const [listing]=snap.content.listings,[payload]=snap.payloads.listings,[event]=snap.activity.listing_event_fields;
  const [reg]=snap.activity.event_registrations,[occupancy]=snap.activity.event_occupancy;
  const [approved]=snap.content.messages,[pending]=snap.content.pending_messages;
  const [approvedPayload]=snap.payloads.messages,[pendingPayload]=snap.payloads.pending_messages;
  const school=listing.school_id,issuer='https://synthetic.invalid';
  // This is an intentionally fixed fixture, not an arbitrary import API. Never consume an external archive.
  // Reject unsupported sections rather than silently ignoring records in a future fixture.
  for(const rows of [snap.content.ideas,snap.content.favorites,snap.content.media,snap.content.idea_images,snap.objects,snap.activity.announcements,snap.activity.polls,snap.activity.votes])assert.equal(rows.length,0);
  for(const rows of [snap.content.listings,snap.content.messages,snap.content.pending_messages,snap.activity.listing_event_fields,snap.activity.event_registrations,snap.activity.event_occupancy])assert.equal(rows.length,1);
  const read=async tx=>{
   const profiles=(await tx`SELECT issuer, subject, user_id, school_id, role, active FROM fam_user_profiles WHERE school_id = ${school};`)[0];
   const listings=(await tx`SELECT id,user_id,school_id,image_key,title,description,created_at,is_event,event_date,event_time,event_type,max_seats,category,price_text,photo_status,status FROM fam_listings WHERE id = ${listing.id};`)[0];
   const messages=(await tx`SELECT id,sender_id,receiver_id,school_id,listing_id,body,created_at,is_read FROM fam_messages WHERE listing_id = ${listing.id};`)[0];
   const pendingMessages=(await tx`SELECT id,sender_id,receiver_id,school_id,listing_id,body,created_at FROM fam_pending_messages WHERE listing_id = ${listing.id};`)[0];
   const registrations=(await tx`SELECT event_id,user_id,school_id,status,created_at FROM fam_event_registrations WHERE event_id = ${listing.id};`)[0];
   const occupancies=(await tx`SELECT event_id,taken FROM fam_event_occupancy WHERE event_id = ${listing.id};`)[0];
   return {profiles,listings,messages,pendingMessages,registrations,occupancies};
  };
  const empty=rows=>Object.values(rows).every(list=>list.length===0);
  const asIso=value=>new Date(value).toISOString();
  const pick=(row,keys)=>Object.fromEntries(keys.map(k=>[k,row[k]]));
  const messageFields=['id','sender_id','receiver_id','school_id','listing_id'];
  function readSnapshot(rows){
   const accounts=rows.profiles.map(x=>pick(x,['issuer','subject','user_id','school_id','role','active']));
   const content={profiles:accounts.map(x=>pick(x,['user_id','school_id'])),
    listings:rows.listings.map(x=>pick(x,['id','user_id','school_id','image_key'])),
    ideas:[],messages:rows.messages.map(x=>pick(x,messageFields)),pending_messages:rows.pendingMessages.map(x=>pick(x,messageFields)),favorites:[],media:[],idea_images:[]};
   const payloads={listings:rows.listings.map(x=>({...pick(x,['id','title','description']),created_at:asIso(x.created_at)})),ideas:[],
    messages:rows.messages.map(x=>({...pick(x,['id','body']),created_at:asIso(x.created_at)})),
    pending_messages:rows.pendingMessages.map(x=>({...pick(x,['id','body']),created_at:asIso(x.created_at)}))};
   const activity={listing_event_fields:rows.listings.map(x=>({...pick(x,['id','is_event','event_date','event_time','event_type']),max_seats:Number(x.max_seats)})),
    event_registrations:rows.registrations.map(x=>({...pick(x,['event_id','user_id','school_id','status']),created_at:asIso(x.created_at)})),
    event_occupancy:rows.occupancies.map(x=>({event_id:x.event_id,taken:Number(x.taken)})),announcements:[],polls:[],votes:[]};
   return {snapshot_id:snap.snapshot_id,accounts,content,payloads,activity,objects:[]};
  }
  const assertMatch=rows=>{
   const restored=readSnapshot(rows);
   const restoredSource={...restored,accounts:restored.accounts.map(({issuer,subject,...row})=>row)};
   const result=verifySyntheticMigrationAcceptance({source:snap,target:restored,restored:restoredSource});
   assert.equal(result.ok,true,JSON.stringify(result));
   assert.equal(rows.listings[0].category,'Мероприятия');
   assert.equal(rows.listings[0].price_text,'Бесплатно');
   assert.equal(rows.listings[0].status,'active');
   assert.equal(rows.listings[0].photo_status,'none');
   assert.equal(rows.messages[0].is_read,false);
   for(const row of rows.profiles){assert.equal(row.issuer,issuer);assert.equal(row.subject,row.user_id);}
  };
  async function restore(injectFailure=false){
   return sql.begin(async tx=>{
    const before=await read(tx);
    if(!empty(before)){
     assertMatch(before);
     return 'unchanged';
    }
    for(const a of snap.accounts){
     // Reject any cross-school UUID collision even with a different provider key.
     assert.equal((await tx`SELECT user_id FROM fam_user_profiles WHERE user_id = ${a.user_id} LIMIT 1;`)[0].length,0);
     await tx`INSERT INTO fam_user_profiles (issuer,subject,user_id,school_id,role,active,person_type,staff_verification_status)
       VALUES (${issuer},${a.user_id},${a.user_id},${a.school_id},${a.role},${a.active},'student','not_required');`;
    }
    await tx`INSERT INTO fam_listings (id,user_id,school_id,title,description,category,price_text,is_event,event_date,event_time,event_type,max_seats,image_key,photo_status,status,created_at)
      VALUES (${listing.id},${listing.user_id},${school},${payload.title},${payload.description},'Мероприятия','Бесплатно',${event.is_event},${event.event_date},${event.event_time},${event.event_type},Unwrap(CAST(${event.max_seats} AS Uint32)),${listing.image_key},'none','active',Unwrap(CAST(${payload.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_messages (id,sender_id,receiver_id,school_id,listing_id,body,is_read,created_at)
      VALUES (${approved.id},${approved.sender_id},${approved.receiver_id},${approved.school_id},${approved.listing_id},${approvedPayload.body},false,Unwrap(CAST(${approvedPayload.created_at} AS Timestamp)));`;
    if(injectFailure)throw Error('synthetic restore interruption');
    await tx`INSERT INTO fam_pending_messages (id,sender_id,receiver_id,school_id,listing_id,body,created_at)
      VALUES (${pending.id},${pending.sender_id},${pending.receiver_id},${pending.school_id},${pending.listing_id},${pendingPayload.body},Unwrap(CAST(${pendingPayload.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_event_registrations (event_id,user_id,school_id,status,created_at)
      VALUES (${reg.event_id},${reg.user_id},${reg.school_id},${reg.status},Unwrap(CAST(${reg.created_at} AS Timestamp)));`;
    await tx`INSERT INTO fam_event_occupancy (event_id,taken) VALUES (${occupancy.event_id},Unwrap(CAST(${occupancy.taken} AS Uint32)));`;
    assertMatch(await read(tx));
    return 'restored';
   });
  }
  assert.equal(empty(await read(sql)),true);
  await assert.rejects(()=>restore(true),/synthetic restore interruption/);
  assert.equal(empty(await read(sql)),true,'interrupted restore must leave all six tables unchanged');
  assert.equal(await restore(),'restored');
  assertMatch(await read(sql));
  assert.equal(await restore(),'unchanged','exact replay must not duplicate records');
  await sql`UPDATE fam_pending_messages SET body = 'synthetic:changed' WHERE id = ${pending.id};`;
  await assert.rejects(()=>restore(),/PAYLOAD_MISMATCH/);
  const altered=await read(sql);
  assert.equal(altered.pendingMessages[0].body,'synthetic:changed','conflicting replay cannot overwrite existing rows');
  assert.equal(altered.messages[0].body,approvedPayload.body);
  await sql`UPDATE fam_pending_messages SET body = ${pendingPayload.body} WHERE id = ${pending.id};`;
  assertMatch(await read(sql));
  console.log('YDB_SYNTHETIC_RESTORE_PASS: six actual tables, atomic rollback, exact replay, divergent replay refused, pending and approved messages remain separated');
 }finally{await driver.close();}
}
await run();
