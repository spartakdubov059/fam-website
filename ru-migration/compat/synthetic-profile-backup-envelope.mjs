import {createHash,timingSafeEqual} from 'node:crypto';
import {encodeSyntheticStateBackup,decodeSyntheticStateBackup,verifySyntheticStateAcceptance} from './synthetic-state-backup-envelope.mjs';
import {verifySyntheticProfileDetails} from './verify-synthetic-profile-details.mjs';

// Version 4 requires profile details alongside the unchanged version 3 archive.
// Deliberately restricted to fake identities and synthetic strings.
const max=8*1024*1024;
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>({ok:false,code});
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export function encodeSyntheticProfileBackup(snapshot,objects,state,profiles){
 try{
  const detail=verifySyntheticProfileDetails(snapshot?.accounts,profiles,profiles);
  if(!detail.ok)return fail(detail.code);
  const inner=encodeSyntheticStateBackup(snapshot,objects,state);
  if(!inner.ok)return inner;
  const bytes=Buffer.from(JSON.stringify({version:4,archive:inner.bytes.toString('base64'),profiles}),'utf8');
  if(bytes.length>max)return fail('BACKUP_TOO_LARGE');
  return {ok:true,bytes,sha256:hash(bytes),live_cutover_authorized:false};
 }catch{return fail('INVALID_PROFILE_DETAIL_ROWS');}
}
export function decodeSyntheticProfileBackup(bytes,expectedSha256){
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>max||typeof expectedSha256!=='string'||!/^[0-9a-f]{64}$/.test(expectedSha256))return fail('INVALID_BACKUP_INPUT');
 if(!timingSafeEqual(Buffer.from(hash(bytes),'hex'),Buffer.from(expectedSha256,'hex')))return fail('BACKUP_DIGEST_MISMATCH');
 try{
  const env=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(env,['version','archive','profiles'])||env.version!==4||typeof env.archive!=='string')return fail('UNSUPPORTED_BACKUP_FORMAT');
  const inner=Buffer.from(env.archive,'base64');
  if(inner.toString('base64')!==env.archive)return fail('INVALID_BACKUP_FORMAT');
  const restored=decodeSyntheticStateBackup(inner,hash(inner));
  if(!restored.ok)return restored;
  const detail=verifySyntheticProfileDetails(restored.snapshot.accounts,env.profiles,env.profiles);
  if(!detail.ok)return fail(detail.code);
  return {...restored,profiles:env.profiles};
 }catch{return fail('INVALID_BACKUP_FORMAT');}
}
export function verifySyntheticProfileAcceptance(input){
 const sides=['source','target','restored'];
 if(!exact(input,sides)||!sides.every(k=>exact(input[k],['snapshot','state','profiles'])))return {ok:false,code:'INVALID_PROFILE_ACCEPTANCE',stage:'input',live_cutover_authorized:false};
 const core=verifySyntheticStateAcceptance(Object.fromEntries(sides.map(k=>[k,{snapshot:input[k].snapshot,state:input[k].state}])));
 if(!core.ok)return core;
 for(const side of ['target','restored']){
  const result=verifySyntheticProfileDetails(input.source.snapshot.accounts,input.source.profiles,input[side].profiles);
  if(!result.ok)return {...result,stage:side+'_profiles'};
 }
 return {...core,code:'SYNTHETIC_PROFILE_ACCEPTANCE_PASS'};
}
