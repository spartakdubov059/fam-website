import {verifySyntheticProfileAcceptance} from './synthetic-profile-backup-envelope.mjs';

// Counts must be gathered independently under the same source snapshot as export.
// This checker only consumes synthetic inputs; equal counts alone cannot prove completeness.
const tables=Object.freeze({
 profiles:['accounts'],
 listings:['content','listings'],
 ideas:['content','ideas'],
 messages:['content','messages'],
 pending_messages:['content','pending_messages'],
 favorites:['content','favorites'],
 media:['content','media'],
 idea_images:['content','idea_images'],
 event_registrations:['activity','event_registrations'],
 event_occupancy:['activity','event_occupancy'],
 announcements:['activity','announcements'],
 polls:['activity','polls'],
 votes:['activity','votes']
});
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=(stage,code,table)=>({ok:false,stage,code,...(table?{table}:{}),live_cutover_authorized:false});
export function verifySyntheticInventoryAcceptance(input){
 if(!exact(input,['source','target','restored','inventory']))return fail('input','INVALID_INVENTORY_INPUT');
 const {source,target,restored,inventory}=input;
 const core=verifySyntheticProfileAcceptance({source,target,restored});
 if(!core.ok)return core;
 if(!exact(inventory,['snapshot_id','counts'])||inventory.snapshot_id!==source.snapshot.snapshot_id||
    !exact(inventory.counts,Object.keys(tables)))return fail('inventory','INVALID_SOURCE_INVENTORY');
 for(const [table,path] of Object.entries(tables)){
  const count=inventory.counts[table];
  if(!Number.isSafeInteger(count)||count<0||count>10000)return fail('inventory','INVALID_SOURCE_COUNT',table);
  for(const [stage,side] of Object.entries({source,target,restored})){
   const rows=path.reduce((obj,key)=>obj[key],side.snapshot);
   if(rows.length!==count)return fail(stage,'SOURCE_INVENTORY_COUNT_MISMATCH',table);
  }
 }
 return {...core,code:'SYNTHETIC_INVENTORY_ACCEPTANCE_PASS',inventory_tables:Object.keys(tables).length,live_cutover_authorized:false};
}
