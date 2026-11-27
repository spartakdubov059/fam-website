const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const zonedTimestamp=/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const fail=code=>({ok:false,code,live_import_authorized:false});

// Field-level compatibility only. This does not authorize reading or importing source data.
export function mapLegacyNotificationReads(sourceRows){
 if(!Array.isArray(sourceRows)||sourceRows.length>10000)return fail('INVALID_NOTIFICATION_READ_ROWS');
 const seen=new Set(),mapped=[];
 for(const row of sourceRows){
  if(!exact(row,['user_id','notification_key','read_at'])||typeof row.user_id!=='string'||!uuid.test(row.user_id)
    ||typeof row.notification_key!=='string'||row.notification_key.length<1||row.notification_key.length>220
    ||typeof row.read_at!=='string')return fail('INVALID_NOTIFICATION_READ_ROW');
  const timestampMatch=zonedTimestamp.exec(row.read_at);
  if(!timestampMatch||!Number.isFinite(Date.parse(row.read_at))
    ||new Date(`${timestampMatch[1]}T00:00:00.000Z`).toISOString().slice(0,10)!==timestampMatch[1])return fail('INVALID_NOTIFICATION_READ_ROW');
  const key=JSON.stringify([row.user_id,row.notification_key]);
  if(seen.has(key))return fail('DUPLICATE_NOTIFICATION_READ');
  seen.add(key);
  mapped.push(Object.freeze({user_id:row.user_id,notification_key:row.notification_key,read_at:new Date(row.read_at)}));
 }
 return Object.freeze({ok:true,code:'NOTIFICATION_READ_MAPPING_READY',rows:Object.freeze(mapped),live_import_authorized:false});
}
