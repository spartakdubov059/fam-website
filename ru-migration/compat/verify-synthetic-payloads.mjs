import { verifySyntheticContentRehearsal } from './verify-synthetic-content-rehearsal.mjs';

// Offline synthetic payload comparison. No real text or database access.
// Every structural row in these four tables must have exactly one payload row.
const schema={listings:['id','title','description','created_at'],ideas:['id','body','created_at'],messages:['id','body','created_at'],pending_messages:['id','body','created_at']};
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=(code,table)=>({ok:false,code,table});
const dummy=x=>typeof x==='string'&&/^synthetic:[a-zA-Z0-9 _.-]{0,200}$/.test(x);
const timestamp=x=>typeof x==='string'&&/^2026-11-24T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export function verifySyntheticPayloads(metadata,source,target){
 if(!verifySyntheticContentRehearsal(metadata).ok)return fail('INVALID_METADATA','input');
 const tables=Object.keys(schema);
 if(!exact(source,tables)||!exact(target,tables))return fail('INVALID_PAYLOAD_MANIFEST','input');
 for(const table of tables){
  const expected=new Set(metadata[table].map(row=>row.id));
  const index=rows=>{
   if(!Array.isArray(rows)||rows.length!==expected.size)return null;
   const map=new Map();
   for(const row of rows){
    if(!exact(row,schema[table])||!expected.has(row.id)||map.has(row.id)||!timestamp(row.created_at)||
       !schema[table].filter(k=>k!=='id'&&k!=='created_at').every(k=>dummy(row[k])))return null;
    map.set(row.id,JSON.stringify(schema[table].map(k=>row[k])));
   }
   return map;
  };
  const a=index(source[table]),b=index(target[table]);
  if(!a||!b)return fail('INVALID_PAYLOAD_ROWS',table);
  for(const [id,value] of a)if(b.get(id)!==value)return fail('PAYLOAD_MISMATCH',table);
 }
 return {ok:true,code:'SYNTHETIC_PAYLOADS_MATCH',live_cutover_authorized:false};
}
