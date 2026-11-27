// Synthetic-only, offline digest-manifest comparison. Does not read actual media or prove the origin of supplied hashes.
export function verifySyntheticAttachmentReconciliation(input) {
  const fail=code=>({ok:false,code});
  const exact=(obj,fields)=>obj!==null&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).length===fields.length&&fields.every(k=>Object.hasOwn(obj,k));
  const validId=x=>typeof x==='string'&&/^synthetic-[a-z0-9-]{1,64}$/.test(x);
  const validDigest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
  if(!exact(input,['expectedMedia','sourceObjects','targetObjects']))return fail('INVALID_ATTACHMENT_MANIFEST');
  const {expectedMedia,sourceObjects,targetObjects}=input;
  if(![expectedMedia,sourceObjects,targetObjects].every(rows=>Array.isArray(rows)&&rows.length<=10000))return fail('INVALID_ATTACHMENT_MANIFEST');
  const expected=new Map();
  for(const row of expectedMedia){
    if(!exact(row,['object_key','user_id'])||!validId(row.object_key)||!validId(row.user_id))return fail('INVALID_EXPECTED_MEDIA');
    if(expected.has(row.object_key))return fail('DUPLICATE_MEDIA_REFERENCE');
    expected.set(row.object_key,row.user_id);
  }
  function index(rows,side){
    const result=new Map();
    for(const row of rows){
      if(!exact(row,['object_key','user_id','byte_length','sha256'])||!validId(row.object_key)||!validId(row.user_id)||
         !Number.isSafeInteger(row.byte_length)||row.byte_length<=0||!validDigest(row.sha256))return fail('INVALID_'+side+'_OBJECT');
      if(result.has(row.object_key))return fail('DUPLICATE_'+side+'_OBJECT');
      if(!expected.has(row.object_key))return fail('UNEXPECTED_'+side+'_OBJECT');
      if(expected.get(row.object_key)!==row.user_id)return fail(side+'_OWNER_MISMATCH');
      result.set(row.object_key,row);
    }
    if(result.size!==expected.size)return fail('MISSING_'+side+'_OBJECT');
    return {ok:true,objects:result};
  }
  const source=index(sourceObjects,'SOURCE');if(!source.ok)return source;
  const target=index(targetObjects,'TARGET');if(!target.ok)return target;
  for(const [key,old] of source.objects){
    const next=target.objects.get(key);
    if(next.byte_length!==old.byte_length||next.sha256!==old.sha256)return fail('ATTACHMENT_BYTES_MISMATCH');
  }
  return {ok:true,code:'SYNTHETIC_ATTACHMENT_RECONCILIATION_PASS',count:expected.size};
}
