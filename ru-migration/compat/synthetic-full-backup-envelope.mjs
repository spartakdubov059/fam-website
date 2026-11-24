import { createHash, timingSafeEqual } from 'node:crypto';
import { verifySyntheticMigrationAcceptance } from './verify-synthetic-migration-acceptance.mjs';

// Full synthetic archive, version 2. Intentionally NOT a reader for real pupil data.
// A separate trusted digest is necessary. SHA-256 alone is not authentication or encryption.
const MAX_BYTES=8*1024*1024;
const MAX_OBJECT=64*1024;
const VERSION=2;
const fail=code=>({ok:false,code});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const syntheticKey=x=>typeof x==='string'&&/^synthetic-[a-z0-9-]{1,64}$/.test(x);
function validateSnapshot(snapshot) {
  if(!snapshot||!Array.isArray(snapshot.accounts))return false;
  const target={...snapshot,accounts:snapshot.accounts.map(row=>({...row,issuer:'https://synthetic.invalid',subject:row?.user_id}))};
  return verifySyntheticMigrationAcceptance({source:snapshot,target,restored:snapshot}).ok===true;
}
function validateObjects(snapshot,objects) {
  if(!Array.isArray(objects)||objects.length!==snapshot.objects.length||objects.length>10000)return false;
  const expected=new Map(snapshot.objects.map(row=>[row.object_key,row]));
  const seen=new Set();
  let total=0;
  for(const item of objects){
    if(!exact(item,['object_key','bytes'])||!syntheticKey(item.object_key)||seen.has(item.object_key)||
       !Buffer.isBuffer(item.bytes)||item.bytes.length>MAX_OBJECT||item.bytes.length===0)return false;
    const marker=item.bytes.toString('latin1');
    if(!/^synthetic:[a-zA-Z0-9 _.-]+$/.test(marker))return false;
    const original=expected.get(item.object_key);
    if(!original||original.byte_length!==item.bytes.length||original.sha256!==hash(item.bytes))return false;
    total+=item.bytes.length;
    if(total>MAX_BYTES)return false;
    seen.add(item.object_key);
  }
  return seen.size===expected.size;
}

export function encodeSyntheticFullBackup(snapshot,objects) {
  try{
    if(!validateSnapshot(snapshot))return fail('INVALID_COMPLETE_SNAPSHOT');
    if(!validateObjects(snapshot,objects))return fail('INVALID_SYNTHETIC_OBJECTS');
    const envelope={version:VERSION,snapshot,objects:objects.map(row=>({object_key:row.object_key,base64:row.bytes.toString('base64')}))};
    const bytes=Buffer.from(JSON.stringify(envelope),'utf8');
    if(bytes.length>MAX_BYTES)return fail('BACKUP_TOO_LARGE');
    return {ok:true,bytes,sha256:hash(bytes),live_cutover_authorized:false};
  }catch{return fail('INVALID_COMPLETE_SNAPSHOT');}
}

export function decodeSyntheticFullBackup(bytes,expectedSha256) {
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX_BYTES||
     typeof expectedSha256!=='string'||!/^[0-9a-f]{64}$/.test(expectedSha256))return fail('INVALID_BACKUP_INPUT');
  if(!timingSafeEqual(Buffer.from(hash(bytes),'hex'),Buffer.from(expectedSha256,'hex')))return fail('BACKUP_DIGEST_MISMATCH');
  try{
    // Reject invalid UTF-8 and noncanonical base64 instead of silently repairing either.
    const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!exact(envelope,['version','snapshot','objects'])||envelope.version!==VERSION)return fail('UNSUPPORTED_BACKUP_FORMAT');
    if(!validateSnapshot(envelope.snapshot))return fail('INVALID_COMPLETE_SNAPSHOT');
    if(!Array.isArray(envelope.objects)||envelope.objects.length!==envelope.snapshot.objects.length||envelope.objects.length>10000)return fail('INVALID_SYNTHETIC_OBJECTS');
    const restored=[];
    for(const row of envelope.objects){
      if(!exact(row,['object_key','base64'])||!syntheticKey(row.object_key)||typeof row.base64!=='string'||
         row.base64.length>4*Math.ceil(MAX_OBJECT/3))return fail('INVALID_SYNTHETIC_OBJECTS');
      const object=Buffer.from(row.base64,'base64');
      if(object.toString('base64')!==row.base64)return fail('INVALID_SYNTHETIC_OBJECTS');
      restored.push({object_key:row.object_key,bytes:object});
    }
    if(!validateObjects(envelope.snapshot,restored))return fail('INVALID_SYNTHETIC_OBJECTS');
    return {ok:true,snapshot:envelope.snapshot,objects:restored,live_cutover_authorized:false};
  }catch{return fail('INVALID_BACKUP_FORMAT');}
}
