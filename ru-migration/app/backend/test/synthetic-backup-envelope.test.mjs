import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSyntheticBackup as encode, decodeSyntheticBackup as decode } from '../../../compat/synthetic-backup-envelope.mjs';
import { verifySyntheticCutoverRehearsal } from '../../../compat/verify-synthetic-cutover-rehearsal.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const accounts=[
    {user_id:'synthetic-a',school_id:'synthetic-school',role:'student',active:true},
    {user_id:'synthetic-b',school_id:'synthetic-school',role:'student',active:false}
  ];
  const content={
    profiles:accounts.map(({user_id,school_id})=>({user_id,school_id})),
    listings:[{id:'synthetic-listing',user_id:'synthetic-a',school_id:'synthetic-school',image_key:'synthetic-photo'}],
    ideas:[],messages:[],pending_messages:[],favorites:[],
    media:[{object_key:'synthetic-photo',user_id:'synthetic-a'}],idea_images:[]
  };
  const photo=Buffer.from('synthetic attachment bytes');
  const source={snapshot_id:'synthetic-batch',accounts,content,objects:[{...content.media[0],byte_length:photo.length,sha256:digest(photo)}]};
  const target=structuredClone(source);
  target.accounts=accounts.map(row=>({...row,issuer:'https://synthetic.invalid',subject:row.user_id}));
  return {source,target,photo};
}

test('writes and reads an independent temporary synthetic backup and verifies restored metadata and attachment bytes',async()=>{
  const {source,target,photo}=fixture();
  const dir=await mkdtemp(join(tmpdir(),'fam-ru-backup-'));
  try{
    const backup=encode(source);
    assert.equal(backup.ok,true);
    const file=join(dir,'backup.json'),object=join(dir,'synthetic-photo');
    await writeFile(file,backup.bytes,{mode:0o600,flag:'wx'});
    await writeFile(object,photo,{mode:0o600,flag:'wx'});
    const restored=decode(await readFile(file),backup.sha256);
    assert.deepEqual(restored.snapshot,source);
    assert.equal(restored.live_cutover_authorized,false);
    const restoredBytes=await readFile(object);
    restored.snapshot.objects[0].sha256=digest(restoredBytes);
    restored.snapshot.objects[0].byte_length=restoredBytes.length;
    assert.equal(verifySyntheticCutoverRehearsal({source,target,restored:restored.snapshot}).ok,true);
    await writeFile(object,Buffer.from('synthetic attachment byteX'));
    const corrupted=await readFile(object);
    restored.snapshot.objects[0].sha256=digest(corrupted);
    restored.snapshot.objects[0].byte_length=corrupted.length;
    assert.equal(verifySyntheticCutoverRehearsal({source,target,restored:restored.snapshot}).code,'ATTACHMENT_BYTES_MISMATCH');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('rejects corrupted and truncated backup bytes against independent digest',()=>{
  const b=encode(fixture().source);
  const changed=Buffer.from(b.bytes);changed[5]^=1;
  assert.equal(decode(changed,b.sha256).code,'BACKUP_DIGEST_MISMATCH');
  assert.equal(decode(b.bytes.subarray(0,-1),b.sha256).code,'BACKUP_DIGEST_MISMATCH');
});
test('rejects wrong version even with matching checksum',()=>{
  const bytes=Buffer.from(JSON.stringify({version:99,snapshot:fixture().source}));
  assert.equal(decode(bytes,digest(bytes)).code,'UNSUPPORTED_BACKUP_FORMAT');
});
test('rejects invalid JSON with matching checksum',()=>{
  const bytes=Buffer.from('{');
  assert.equal(decode(bytes,digest(bytes)).code,'INVALID_BACKUP_FORMAT');
});
test('refuses raw personal fields and inconsistent owners before backup',()=>{
  const source=fixture().source;source.accounts[0].email='synthetic@example.invalid';
  assert.equal(encode(source).code,'INVALID_SYNTHETIC_SNAPSHOT');
  const other=fixture().source;other.objects[0].user_id='synthetic-b';
  assert.equal(encode(other).code,'INVALID_SYNTHETIC_SNAPSHOT');
});
test('refuses a malformed manifest even if checksum matches',()=>{
  const source=fixture().source;source.content.profiles.pop();
  const bytes=Buffer.from(JSON.stringify({version:1,snapshot:source}));
  assert.equal(decode(bytes,digest(bytes)).code,'INVALID_SYNTHETIC_SNAPSHOT');
});
test('rejects absent, invalid and uppercase digest values',()=>{
  const b=encode(fixture().source);
  for(const d of [undefined,'','x'.repeat(64),b.sha256.toUpperCase()])assert.equal(decode(b.bytes,d).code,'INVALID_BACKUP_INPUT');
});
test('rejects oversized and empty backups before decoding',()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(8*1024*1024+1)])assert.equal(decode(bytes,'a'.repeat(64)).code,'INVALID_BACKUP_INPUT');
});
test('inactive profile remains inactive after serialized restore',()=>{
  const b=encode(fixture().source);const r=decode(b.bytes,b.sha256);
  assert.equal(r.snapshot.accounts[1].active,false);
  assert.equal(r.snapshot.accounts[1].user_id,'synthetic-b');
});
