import { verifySyntheticCutoverRehearsal } from './verify-synthetic-cutover-rehearsal.mjs';
import { verifySyntheticPayloads } from './verify-synthetic-payloads.mjs';
import { verifySyntheticSchoolActivity } from './verify-synthetic-school-activity.mjs';

// Combined offline acceptance rehearsal. Every covered section is mandatory.
// Never interprets a self-consistent set of fixtures as proof of production completeness.
export function verifySyntheticMigrationAcceptance(input) {
  const fail=(stage,code,table)=>({ok:false,stage,code,...(table?{table}:{}),live_cutover_authorized:false});
  const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
  const fields=['snapshot_id','accounts','content','objects','payloads','activity'];
  const sides=['source','target','restored'];
  if(!exact(input,sides)||!sides.every(k=>exact(input[k],fields)))return fail('input','INVALID_COMPLETE_SNAPSHOT');
  const {source,target,restored}=input;
  const project=({snapshot_id,accounts,content,objects})=>({snapshot_id,accounts,content,objects});
  try {
    const core=verifySyntheticCutoverRehearsal({source:project(source),target:project(target),restored:project(restored)});
    if(!core.ok)return fail(core.stage,core.code);
    for(const side of ['target','restored']){
      const payload=verifySyntheticPayloads(source.content,source.payloads,input[side].payloads);
      if(!payload.ok)return fail(side+'_payloads',payload.code,payload.table);
      const activity=verifySyntheticSchoolActivity(source.content,source.activity,input[side].activity);
      if(!activity.ok)return fail(side+'_activity',activity.code,activity.table);
    }
    const activity=verifySyntheticSchoolActivity(source.content,source.activity,target.activity);
    return {ok:true,code:'SYNTHETIC_ACCEPTANCE_PASS',accounts:core.accounts,attachments:core.attachments,
      content_counts:core.counts,activity_counts:activity.counts,live_cutover_authorized:false};
  }catch{return fail('input','INVALID_COMPLETE_SNAPSHOT');}
}
