import { verifySyntheticMigrationReconciliation } from './verify-synthetic-migration-reconciliation.mjs';
import { verifySyntheticAttachmentReconciliation } from './verify-synthetic-attachment-reconciliation.mjs';

// Offline acceptance rehearsal: the caller supplies normalized SYNTHETIC manifests.
// No backup is created/restored here, no route is switched, and no live readiness is implied.
export function verifySyntheticCutoverRehearsal(input) {
  const reject=(stage,code)=>({ok:false,stage,code});
  const exact=(obj,keys)=>obj!==null&&typeof obj==='object'&&!Array.isArray(obj)&&
    Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
  const fields=['snapshot_id','accounts','content','objects'];
  if(!exact(input,['source','target','restored'])||
     ![input.source,input.target,input.restored].every(x=>exact(x,fields)))return reject('input','INVALID_SNAPSHOT');
  const {source,target,restored}=input;
  if(typeof source.snapshot_id!=='string'||!/^synthetic-[a-z0-9-]{1,64}$/.test(source.snapshot_id)||
     target.snapshot_id!==source.snapshot_id||restored.snapshot_id!==source.snapshot_id)return reject('input','SNAPSHOT_ID_MISMATCH');
  const compare=(old,next)=>verifySyntheticMigrationReconciliation({
    sourceAccounts:old.accounts,targetAccounts:next.accounts,sourceContent:old.content,targetContent:next.content
  });
  const data=compare(source,target);
  if(!data.ok)return reject('target_data',data.code);
  const media=verifySyntheticAttachmentReconciliation({
    expectedMedia:source.content.media,sourceObjects:source.objects,targetObjects:target.objects
  });
  if(!media.ok)return reject('target_attachments',media.code);
  // Independently supplied restored source must match the same target and its account invariants.
  const restoredData=compare(restored,target);
  if(!restoredData.ok)return reject('restored_data',restoredData.code);
  const restoredMedia=verifySyntheticAttachmentReconciliation({
    expectedMedia:source.content.media,sourceObjects:source.objects,targetObjects:restored.objects
  });
  if(!restoredMedia.ok)return reject('restored_attachments',restoredMedia.code);
  return {ok:true,code:'SYNTHETIC_CUTOVER_REHEARSAL_PASS',accounts:data.accounts,attachments:media.count,
    counts:data.counts,live_cutover_authorized:false};
}
