import {createHash,timingSafeEqual} from 'node:crypto';
import {encodeSyntheticFullBackup,decodeSyntheticFullBackup} from './synthetic-full-backup-envelope.mjs';
import {verifySyntheticRecordState} from './verify-synthetic-record-state.mjs';
import {verifySyntheticMigrationAcceptance} from './verify-synthetic-migration-acceptance.mjs';

// Version 3 wraps the unchanged v2 format and requires record state. No legacy downgrade.
const max=8*1024*1024;
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>({ok:false,code});
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export function encodeSyntheticStateBackup(snapshot,objects,state){
 try{
  if(!verifySyntheticRecordState(snapshot?.content,state,state).ok)return fail('INVALID_RECORD_STATE');
  const inner=encodeSyntheticFullBackup(snapshot,objects);
  if(!inner.ok)return inner;
  const bytes=Buffer.from(JSON.stringify({version:3,archive:inner.bytes.toString('base64'),state}),'utf8');
  if(bytes.length>max)return fail('BACKUP_TOO_LARGE');
  return {ok:true,bytes,sha256:hash(bytes),live_cutover_authorized:false};
 }catch{return fail('INVALID_RECORD_STATE');}
}
export function decodeSyntheticStateBackup(bytes,expectedSha256){
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>max||typeof expectedSha256!=='string'||!/^[0-9a-f]{64}$/.test(expectedSha256))return fail('INVALID_BACKUP_INPUT');
 if(!timingSafeEqual(Buffer.from(hash(bytes),'hex'),Buffer.from(expectedSha256,'hex')))return fail('BACKUP_DIGEST_MISMATCH');
 try{
  const env=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(env,['version','archive','state'])||env.version!==3||typeof env.archive!=='string')return fail('UNSUPPORTED_BACKUP_FORMAT');
  const inner=Buffer.from(env.archive,'base64');
  if(inner.toString('base64')!==env.archive)return fail('INVALID_BACKUP_FORMAT');
  const restored=decodeSyntheticFullBackup(inner,hash(inner));
  if(!restored.ok)return restored;
  if(!verifySyntheticRecordState(restored.snapshot.content,env.state,env.state).ok)return fail('INVALID_RECORD_STATE');
  return {...restored,state:env.state};
 }catch{return fail('INVALID_BACKUP_FORMAT');}
}
export function verifySyntheticStateAcceptance(input){
 const sides=['source','target','restored'];
 if(!exact(input,sides)||!sides.every(k=>exact(input[k],['snapshot','state'])))return {ok:false,code:'INVALID_STATE_ACCEPTANCE',stage:'input',live_cutover_authorized:false};
 const core=verifySyntheticMigrationAcceptance(Object.fromEntries(sides.map(k=>[k,input[k].snapshot])));
 if(!core.ok)return core;
 for(const side of ['target','restored']){
  const result=verifySyntheticRecordState(input.source.snapshot.content,input.source.state,input[side].state);
  if(!result.ok)return {...result,stage:side+'_state'};
 }
 return {...core,code:'SYNTHETIC_STATE_ACCEPTANCE_PASS'};
}
