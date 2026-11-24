import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeSyntheticFullBackup as encode,decodeSyntheticFullBackup as decode} from '../../../compat/synthetic-full-backup-envelope.mjs';
import {encodeSyntheticBackup as encodeV1} from '../../../compat/synthetic-backup-envelope.mjs';
import {verifySyntheticMigrationAcceptance as verify} from '../../../compat/verify-synthetic-migration-acceptance.mjs';

function fixture(){
  const a='synthetic-a',b='synthetic-b',s='synthetic-school',l='synthetic-event';
  const accounts=[{user_id:a,school_id:s,role:'council_member',active:true},{user_id:b,school_id:s,role:'student',active:true}];
  const content={profiles:accounts.map(({user_id,school_id})=>({user_id,school_id})),listings:[{id:l,user_id:a,school_id:s,image_key:'synthetic-photo'}],ideas:[{id:'synthetic-idea',user_id:b,school_id:s}],messages:[{id:'synthetic-msg',sender_id:b,receiver_id:a,school_id:s,listing_id:l}],pending_messages:[{id:'synthetic-pending',sender_id:a,receiver_id:b,school_id:s,listing_id:l}],favorites:[{user_id:b,listing_id:l}],media:[{object_key:'synthetic-photo',user_id:a}],idea_images:[]};
  const created_at='2026-11-24T12:00:00.000Z',end='2026-11-25T12:00:00.000Z';
  const payloads={listings:[{id:l,title:'synthetic:title',description:'synthetic:description',created_at}],ideas:[{id:'synthetic-idea',body:'synthetic:idea',created_at}],messages:[{id:'synthetic-msg',body:'synthetic:message',created_at}],pending_messages:[{id:'synthetic-pending',body:'synthetic:pending',created_at}]};
  const activity={listing_event_fields:[{id:l,is_event:true,event_date:'2026-11-25',event_time:'10:00',event_type:'limited',max_seats:1}],event_registrations:[{event_id:l,user_id:b,school_id:s,status:'confirmed',created_at}],event_occupancy:[{event_id:l,taken:1}],announcements:[{announcement_id:'synthetic-news',school_id:s,author_id:a,title:'synthetic:news',body:'synthetic:body',kind:'news',event_starts_at:null,published_at:created_at,expires_at:end}],polls:[{poll_id:'synthetic-poll',school_id:s,author_id:a,question:'synthetic:question',options:['synthetic:yes','synthetic:no'],created_at,closes_at:end}],votes:[{poll_id:'synthetic-poll',voter_id:b,school_id:s,choice_index:1,created_at}]};
  const source={snapshot_id:'synthetic-batch',accounts,content,objects:[{...content.media[0],byte_length:12,sha256:'a'.repeat(64)}],payloads,activity};
  const target=structuredClone(source);
  target.accounts=accounts.map((row,i)=>({...row,issuer:'https://synthetic.invalid',subject:'synthetic-identity-'+i}));
  return {source,target,restored:structuredClone(source)};
}

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function full(){
  const f=fixture();
  const bytes=Buffer.from('synthetic:photo fixture');
  const objects=[{object_key:'synthetic-photo',bytes}];
  for(const side of ['source','target','restored']){
    f[side].objects[0].byte_length=bytes.length;
    f[side].objects[0].sha256=digest(bytes);
  }
  return {...f,objects};
}
function repack(envelope){const bytes=Buffer.from(JSON.stringify(envelope));return [bytes,digest(bytes)];}

test('round trip full archive through disk with independent object bytes, poll votes and message payloads',async()=>{
  const f=full();const dir=await mkdtemp(join(tmpdir(),'fam-ru-full-backup-'));
  try{
    const b=encode(f.source,f.objects);assert.equal(b.ok,true);
    assert.equal(b.live_cutover_authorized,false);
    const path=join(dir,'backup-v2.json');
    await writeFile(path,b.bytes,{mode:0o600,flag:'wx'});
    const r=decode(await readFile(path),b.sha256);assert.equal(r.ok,true);
    assert.deepEqual(r.snapshot,f.source);assert.deepEqual(r.objects,f.objects);
    assert.equal(r.live_cutover_authorized,false);
    const restored=r.snapshot;
    restored.objects[0].sha256=digest(r.objects[0].bytes);
    restored.objects[0].byte_length=r.objects[0].bytes.length;
    assert.equal(verify({source:f.source,target:f.target,restored}).ok,true);
    assert.equal(restored.activity.votes.length,1);
    assert.equal(restored.payloads.pending_messages.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing or unexpected or duplicated object bytes rejected',()=>{
  const f=full();
  for(const objects of [[],[...f.objects,...f.objects],[{...f.objects[0],object_key:'synthetic-extra'}]])assert.equal(encode(f.source,objects).code,'INVALID_SYNTHETIC_OBJECTS');
});
test('same-sized modified object cannot be archived',()=>{
  const f=full();f.objects[0].bytes[10]^=1;
  assert.equal(encode(f.source,f.objects).code,'INVALID_SYNTHETIC_OBJECTS');
});
test('refuses non-fixture binary even if its digest is correct',()=>{
  const f=full();const bytes=Buffer.from([0,1,2,3]);
  f.objects[0].bytes=bytes;f.source.objects[0].byte_length=bytes.length;f.source.objects[0].sha256=digest(bytes);
  assert.equal(encode(f.source,f.objects).code,'INVALID_SYNTHETIC_OBJECTS');
});
test('missing payloads or activity cannot be silently dropped',()=>{
  for(const section of ['payloads','activity']){const f=full();delete f.source[section];assert.equal(encode(f.source,f.objects).code,'INVALID_COMPLETE_SNAPSHOT');}
});
test('truncated or changed archive fails independent digest',()=>{
  const f=full();const b=encode(f.source,f.objects);
  assert.equal(decode(b.bytes.subarray(0,-1),b.sha256).code,'BACKUP_DIGEST_MISMATCH');
  const corrupt=Buffer.from(b.bytes);corrupt[8]^=1;
  assert.equal(decode(corrupt,b.sha256).code,'BACKUP_DIGEST_MISMATCH');
});
test('v1 metadata-only backup cannot be decoded as complete v2',()=>{
  const f=full();const {payloads,activity,...core}=f.source;const b=encodeV1(core);
  assert.equal(b.ok,true);assert.equal(decode(b.bytes,b.sha256).code,'UNSUPPORTED_BACKUP_FORMAT');
});
test('corrupt object bytes fail even if archive digest is recomputed',()=>{
  const f=full();const b=encode(f.source,f.objects);const env=JSON.parse(b.bytes.toString());
  const changed=Buffer.from(f.objects[0].bytes);changed[10]^=1;env.objects[0].base64=changed.toString('base64');
  assert.equal(decode(...repack(env)).code,'INVALID_SYNTHETIC_OBJECTS');
});
test('noncanonical base64 is rejected',()=>{
  const f=full();const env=JSON.parse(encode(f.source,f.objects).bytes.toString());
  env.objects[0].base64+='\n';assert.equal(decode(...repack(env)).code,'INVALID_SYNTHETIC_OBJECTS');
});
test('missing section with newly computed digest remains invalid',()=>{
  const f=full();const env=JSON.parse(encode(f.source,f.objects).bytes.toString());delete env.snapshot.activity;
  assert.equal(decode(...repack(env)).code,'INVALID_COMPLETE_SNAPSHOT');
});
test('invalid UTF8 does not become valid JSON silently',()=>{
  const bytes=Buffer.from([0x7b,0xff,0x7d]);
  assert.equal(decode(bytes,digest(bytes)).code,'INVALID_BACKUP_FORMAT');
});
test('rejects empty, oversized, or missing digest',()=>{
  const f=full();const b=encode(f.source,f.objects);
  assert.equal(decode(b.bytes,undefined).code,'INVALID_BACKUP_INPUT');
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(8*1024*1024+1)])assert.equal(decode(bytes,'a'.repeat(64)).code,'INVALID_BACKUP_INPUT');
});
test('object size bound enforced before archive creation',()=>{
  const f=full();const bytes=Buffer.from('synthetic:'+'a'.repeat(65536));
  f.objects[0].bytes=bytes;f.source.objects[0].byte_length=bytes.length;f.source.objects[0].sha256=digest(bytes);
  assert.equal(encode(f.source,f.objects).code,'INVALID_SYNTHETIC_OBJECTS');
});
