// Isolated migration primitive. No runtime route or database write. Do not use untrusted browser data.
export function mapLegacyProfileForMigration(input) {
  const fail=code=>({ok:false,code});
  // This is a normalized, operator-reviewed source snapshot, not a browser payload.
  const fields=['id','school_id','role','active','first_name','last_name','class_name','city','avatar_url','person_type','staff_position','staff_verification_status'];
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==fields.length || !fields.every(k=>Object.hasOwn(input,k))) return fail('INVALID_PROFILE_FIELDS');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(typeof input.id!=='string'||!uuid.test(input.id)||input.id.toLowerCase()!==input.id)return fail('INVALID_LEGACY_ID');
  if(!['lyceum_3','gymnasium_4'].includes(input.school_id)||!['student','council_member','school_admin'].includes(input.role)||typeof input.active!=='boolean')return fail('INVALID_PROFILE_AUTHORITY');
  const nullableText=(x,max)=>x===null||(typeof x==='string'&&x.length<=max&&!/[\u0000-\u001f\u007f]/.test(x));
  if(!nullableText(input.first_name,80)||!nullableText(input.last_name,80)||!nullableText(input.city,120)||!nullableText(input.staff_position,100))return fail('INVALID_PROFILE_TEXT');
  if(!['student','school_staff','parent'].includes(input.person_type)||!['not_required','pending','approved','rejected'].includes(input.staff_verification_status))return fail('INVALID_PERSON_TYPE');
  if(input.class_name!==null&&input.class_name!==''&&(typeof input.class_name!=='string'||!/^(?:[5-9]|1[01])[АБВГК]$/u.test(input.class_name)))return fail('INVALID_CLASS');
  if(input.person_type!=='student'&&input.class_name!==null&&input.class_name!=='')return fail('PERSON_TYPE_CLASS_CONFLICT');
  if(input.person_type==='school_staff'){
    if(typeof input.staff_position!=='string'||!input.staff_position.trim()||input.staff_verification_status==='not_required')return fail('STAFF_REVIEW_REQUIRED');
  }else if((input.staff_position!==null&&input.staff_position!=='')||input.staff_verification_status!=='not_required'){
    return fail('STAFF_REVIEW_REQUIRED');
  }
  // A nonempty old avatar cannot safely be carried over as a public URL or dropped silently.
  if(input.avatar_url!==null&&input.avatar_url!=='')return fail('AVATAR_RECONCILIATION_REQUIRED');
  const {id,...rest}=input;
  // No issuer or subject: the result is a staged profile, not a login-enabled account.
  return {ok:true,profile:Object.freeze({user_id:id,...rest})};
}
