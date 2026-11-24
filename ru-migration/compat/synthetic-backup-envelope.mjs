import { createHash, timingSafeEqual } from 'node:crypto';
import { verifySyntheticCutoverRehearsal } from './verify-synthetic-cutover-rehearsal.mjs';

const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const fail = code => ({ok:false,code});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function validate(snapshot) {
  // Derive a fake target identity solely for strict offline snapshot validation.
  // This never establishes real identity ownership or migration permission.
  if(!snapshot || !Array.isArray(snapshot.accounts))return false;
  const target = {...snapshot,accounts:snapshot.accounts.map(row=>({
    ...row,issuer:'https://synthetic.invalid',subject:row?.user_id
  }))};
  return verifySyntheticCutoverRehearsal({source:snapshot,target,restored:snapshot}).ok===true;
}

export function encodeSyntheticBackup(snapshot) {
  try {
    if(!validate(snapshot))return fail('INVALID_SYNTHETIC_SNAPSHOT');
    const bytes=Buffer.from(JSON.stringify({version:VERSION,snapshot}),'utf8');
    if(bytes.length>MAX_BYTES)return fail('BACKUP_TOO_LARGE');
    return {ok:true,bytes,sha256:hash(bytes)};
  }catch{return fail('INVALID_SYNTHETIC_SNAPSHOT');}
}

export function decodeSyntheticBackup(bytes,expectedSha256) {
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX_BYTES||
     typeof expectedSha256!=='string'||!/^[0-9a-f]{64}$/.test(expectedSha256))return fail('INVALID_BACKUP_INPUT');
  // The expected digest must come from an independent trusted record.
  // It is an integrity check, not an authentication or encryption mechanism.
  if(!timingSafeEqual(Buffer.from(hash(bytes),'hex'),Buffer.from(expectedSha256,'hex')))return fail('BACKUP_DIGEST_MISMATCH');
  try {
    const envelope=JSON.parse(bytes.toString('utf8'));
    if(!envelope||Array.isArray(envelope)||Object.keys(envelope).length!==2||
       envelope.version!==VERSION||!Object.hasOwn(envelope,'snapshot'))return fail('UNSUPPORTED_BACKUP_FORMAT');
    if(!validate(envelope.snapshot))return fail('INVALID_SYNTHETIC_SNAPSHOT');
    return {ok:true,snapshot:envelope.snapshot,live_cutover_authorized:false};
  }catch{return fail('INVALID_BACKUP_FORMAT');}
}
