import {verifySyntheticContentRehearsal} from './verify-synthetic-content-rehearsal.mjs';

// Strict normalized synthetic state inventory. No live source mapping or permission grant.
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=(code,table)=>({ok:false,code,table,live_cutover_authorized:false});
const ts=x=>typeof x==='string'&&/^2026-11-24T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const dummy=x=>typeof x==='string'&&(x===''||/^synthetic:[a-zA-Z0-9 _.-]{1,200}$/.test(x));
const schemas={
 listings:{key:['id'],fields:['id','category','price_text','status','photo_status']},
 ideas:{key:['id'],fields:['id','image_status','ai_status','ai_summary','ai_reason','admin_status']},
 messages:{key:['id'],fields:['id','is_read']},
 favorites:{key:['user_id','listing_id'],fields:['user_id','listing_id','created_at']},
 media:{key:['object_key'],fields:['object_key','status','created_at','claim_token','claim_until']},
 idea_images:{key:['idea_id','image_index'],fields:['idea_id','image_index','created_at']}
};
export function verifySyntheticRecordState(metadata,source,target){
 if(!verifySyntheticContentRehearsal(metadata).ok)return fail('INVALID_METADATA','input');
 const tables=Object.keys(schemas);
 if(!exact(source,tables)||!exact(target,tables))return fail('INVALID_STATE_MANIFEST','input');
 const linked=new Set([...metadata.listings.map(x=>x.image_key).filter(Boolean),...metadata.idea_images.map(x=>x.object_key)]);
 const ideaImages=new Set(metadata.idea_images.map(x=>x.idea_id));
 function valid(table,row,meta){
  switch(table){
   case 'listings':
    return ['Мероприятия','synthetic:category'].includes(row.category)&&['Бесплатно','synthetic:price'].includes(row.price_text)&&
      ['pending','active','rejected','processing'].includes(row.status)&&['none','pending','approved','rejected'].includes(row.photo_status)&&
      (meta.image_key?row.photo_status!=='none':row.photo_status==='none')&&
      !(row.status==='active'&&meta.image_key&&row.photo_status!=='approved');
   case 'ideas':
    return ['none','pending','approved','rejected'].includes(row.image_status)&&['pending','approved','rejected'].includes(row.ai_status)&&
      ['new','in_progress','done','rejected'].includes(row.admin_status)&&dummy(row.ai_summary)&&dummy(row.ai_reason)&&
      (ideaImages.has(row.id)?['pending','approved'].includes(row.image_status):['none','rejected'].includes(row.image_status))&&
      !(row.ai_status==='rejected'&&ideaImages.has(row.id))&&
      (row.ai_status==='approved'||row.admin_status==='new');
   case 'messages':return typeof row.is_read==='boolean';
   case 'favorites':case 'idea_images':return ts(row.created_at);
   case 'media':
    // In-flight deletion leases must be resolved in an independently approved migration plan.
    return row.status===(linked.has(row.object_key)?'linked':'pending')&&row.claim_token===''&&ts(row.created_at)&&ts(row.claim_until);
   default:return false;
  }
 }
 for(const table of tables){
  const {key,fields}=schemas[table],keyOf=row=>JSON.stringify(key.map(k=>row[k]));
  const expected=new Map(metadata[table].map(row=>[keyOf(row),row]));
  const index=rows=>{
   if(!Array.isArray(rows)||rows.length!==expected.size)return null;
   const result=new Map();
   for(const row of rows){
    if(!exact(row,fields))return null;
    const k=keyOf(row),meta=expected.get(k);
    if(!meta||result.has(k)||!valid(table,row,meta))return null;
    result.set(k,JSON.stringify(fields.map(f=>row[f])));
   }
   return result;
  };
  const a=index(source[table]),b=index(target[table]);
  if(!a||!b)return fail('INVALID_STATE_ROWS',table);
  for(const [k,v] of a)if(b.get(k)!==v)return fail('RECORD_STATE_MISMATCH',table);
 }
 return {ok:true,code:'SYNTHETIC_RECORD_STATE_MATCH',live_cutover_authorized:false};
}
