// Offline evidence completeness only. No verifier of real legal attestations is installed.
export const LEGAL_CUTOVER_CRITERIA=Object.freeze([["operator","152-FZ arts. 3, 18.1, 22.1","School/adult-approved operator determination, authority and responsible person"],["localization","152-FZ art. 18(5)","Provider and deployment evidence for RF databases, media, backups, replicas, logs and restore"],["data_flows","152-FZ arts. 6, 7, 12, 18(5)","Complete recipient/location inventory; actual network and CI trace; processor contracts; cross-border assessment"],["minors_and_minimization","152-FZ arts. 5, 6, 9; Civil Code arts. 26, 28","Purpose and lawful basis by data category and age; separate consent and representative authority where required"],["notices_and_policy","152-FZ arts. 18.1, 22; art. 12","Approved policy, RKN notice receipt or reasoned exception; separate transfer notification if applicable"],["security_and_rights","152-FZ arts. 14, 19–21; PP 1119; FSTEC 21; FSTEC 117 if applicable","Threat model, protection level, independent tests, access/withdrawal/deletion/incident procedures, school system classification"],["chat_and_child_safety","149-FZ arts. 10, 10.1, 16; 436-FZ arts. 5, 6, 14","Counsel determination of chat/ORI obligations and school system status; age-appropriate content and safety testing"],["foreign_source_exit","152-FZ arts. 5, 12, 21; RKN Order 179","Approved cessation and deletion schedule, RF restore proof, legal retention and separately authorized destruction procedure"],["current_service_remediation","152-FZ arts. 18(5), 19, 21, 22","Adult operator assessment of current processing, containment and remediation decision; no continued unlawful collection"],["school_and_operator_approval","152-FZ arts. 6, 18.1, 19","Documented approval by authorized operator and school, applicable legal review and release-specific change authorization"]].map(([id,basis,proof])=>Object.freeze({id,basis,proof})));
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const iso=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export function evaluateLegalCutoverEvidence(manifest, releaseSha256, now=Date.now()) {
 const blockers=[];
 const fail=()=>({ok:false,live_cutover_authorized:false,blockers,criteria:LEGAL_CUTOVER_CRITERIA.length});
 if(!hex(releaseSha256)||!Number.isSafeInteger(now)||!exact(manifest,['version','release_sha256','receipts'])||manifest.version!==1||manifest.release_sha256!==releaseSha256||!Array.isArray(manifest.receipts)||manifest.receipts.length>LEGAL_CUTOVER_CRITERIA.length){
  blockers.push('legal: missing or invalid release-bound evidence manifest');return fail();
 }
 const seen=new Set();
 for(const r of manifest.receipts){
  if(!exact(r,['criterion','release_sha256','artifact_sha256','reviewed_at','status'])||!LEGAL_CUTOVER_CRITERIA.some(x=>x.id===r.criterion)||r.release_sha256!==releaseSha256||!hex(r.artifact_sha256)||!iso(r.reviewed_at)||Date.parse(r.reviewed_at)>now||now-Date.parse(r.reviewed_at)>14*86400000||r.status!=='reviewed'||seen.has(r.criterion)){
   blockers.push('legal: invalid, duplicate or stale evidence receipt');continue;
  }
  seen.add(r.criterion);
 }
 for(const {id} of LEGAL_CUTOVER_CRITERIA)if(!seen.has(id))blockers.push('legal: missing '+id);
 // Hashes and caller-supplied review labels are NOT signatures or legal proof.
 // Deliberately no bypass, even for structurally complete manifests.
 blockers.push('legal: trusted operator and school evidence verification not implemented');
 return fail();
}
