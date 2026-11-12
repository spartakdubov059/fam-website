// Staging only; must be deployed with the private queue migration, a verified free
// vision endpoint and a cron trigger. Never falls back to a paid model.
import { buildModerationCollage } from "../photo-batch-collage.ts";
import { inspectPhotoBatch, planBatchReview, PHOTO_POLICY_VERSION, MAX_FILE_BYTES } from "../photo-batch-policy.js";

const BASE=Deno.env.get("SUPABASE_URL")??"";
const WORKER_TOKEN=Deno.env.get("FAM_AGENT_WORKER_TOKEN")??"";
const FREE_ENDPOINT=Deno.env.get("FAM_FREE_VISION_ENDPOINT")??"";
const FREE_VERIFIED=Deno.env.get("FAM_FREE_VISION_VERIFIED")==="1";
const FREE_TOKEN=Deno.env.get("FAM_FREE_VISION_TOKEN")??"";
function key(name: string) {
  const s=Deno.env.get(name)||"";
  try { const j=JSON.parse(s);if(typeof j?.default==="string")return j.default; }catch{}
  return s;
}
const SECRET=key("SUPABASE_SECRET_KEYS")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ||Deno.env.get("SUPABASE_SECRET_KEY")||"";
const LEGACY=SECRET.startsWith("eyJ");
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json;charset=utf-8"}});}
async function validToken(got: string) {
  if(!got||!WORKER_TOKEN)return false;
  const bytes=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest("SHA-256",bytes.encode(got)),crypto.subtle.digest("SHA-256",bytes.encode(WORKER_TOKEN))]);
  const left=new Uint8Array(a),right=new Uint8Array(b);let different=0;
  for(let i=0;i<left.length;i++)different |= left[i]^right[i];
  return different===0;
}
function serviceHeaders(mime: string="application/json") {
  const h: Record<string,string>={"apikey":SECRET,"Content-Type":mime};
  if(LEGACY)h["Authorization"]="Bearer "+SECRET;
  return h;
}
async function sqlRpc(name: string,params: unknown) {
  const r=await fetch(BASE+"/rest/v1/rpc/"+name,{method:"POST",headers:serviceHeaders(),body:JSON.stringify(params)});
  if(!r.ok)throw new Error("rpc_failed_"+name+"_"+r.status);
  return await r.json();
}
async function row(table: string,filter: string,select: string="*") {
  const r=await fetch(BASE+"/rest/v1/"+table+"?select="+encodeURIComponent(select)+"&"+filter+"&limit=1",{
    headers:serviceHeaders()
  });
  if(!r.ok)throw new Error("lookup_failed");
  const arr=await r.json();return Array.isArray(arr)?arr[0]||null:null;
}
async function stagedPhoto(path: string,owner: string) {
  if(typeof path!=="string"||!path.startsWith(owner+"/listing_"+owner+"_")||path.includes("..")||path.includes("%")||
     !/\.(?:jpg|jpeg|png|webp)$/i.test(path))throw new Error("invalid_private_path");
  const r=await fetch(BASE+"/storage/v1/object/listing-images-pending/"+path,{
    headers:serviceHeaders("application/octet-stream"),redirect:"error"
  });
  if(!r.ok||Number(r.headers.get("content-length")||0)>MAX_FILE_BYTES)throw new Error("private_file_not_accessible");
  const bytes=new Uint8Array(await r.arrayBuffer());
  return {bytes,mime:(r.headers.get("content-type")||"").split(";")[0].trim().toLowerCase()};
}
async function removeStorageObject(bucket: string,path: string) {
  const r=await fetch(BASE+"/storage/v1/object/"+bucket,{
    method:"DELETE",headers:serviceHeaders(),body:JSON.stringify({prefixes:[path]})
  });
  return r.ok;
}
async function uploadApprovedPhoto(bytes: Uint8Array,owner: string) {
  const path="listing_"+owner+"_"+crypto.randomUUID()+".jpg";
  const r=await fetch(BASE+"/storage/v1/object/listings-images/"+path,{
    method:"POST",headers:{...serviceHeaders("image/jpeg"),"x-upsert":"false"},body:new Uint8Array(bytes).buffer
  });
  if(!r.ok)throw new Error("public_upload_failed");
  return {path,url:BASE+"/storage/v1/object/public/listings-images/"+path};
}
function bytesToBase64(bytes: Uint8Array) {
  let binary="";
  for(let offset=0;offset<bytes.length;offset+=8192)
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(binary);
}
async function freeVisionReview(bytes: Uint8Array,title: unknown,category: unknown) {
  if(!FREE_VERIFIED||!FREE_ENDPOINT||FREE_TOKEN.length<16)return {decision:"pending",reason:"unconfigured"};
  let url;
  try {url=new URL(FREE_ENDPOINT);}catch{return {decision:"pending",reason:"invalid_endpoint"};}
  if(url.protocol!=="https:"||url.username||url.password||url.hash)
    return {decision:"pending",reason:"invalid_endpoint"};
  try {
    const controller=new AbortController();
    const id=setTimeout(()=>controller.abort(),15000);
    try {
      const result=await fetch(url.toString(),{
        method:"POST",redirect:"error",headers:{"Content-Type":"application/json","Authorization":"Bearer "+FREE_TOKEN},
        body:JSON.stringify({policy_version:PHOTO_POLICY_VERSION,purpose:"school_listing_photo_collage",
          title:String(title||"").slice(0,80),category:String(category||"").slice(0,80),
          mime:"image/jpeg",image_base64:bytesToBase64(bytes)}),
        signal:controller.signal
      });
      if(!result.ok)return {decision:"pending",reason:"free_model_unavailable"};
      const response=await result.json().catch(()=>null);
      if(response?.policy_version!==PHOTO_POLICY_VERSION||
         !["approve","reject","manual_review"].includes(response?.decision))
        return {decision:"pending",reason:"invalid_model_response"};
      // Require the complete, unambiguous 1-collage verdict; no partial approvals.
      return {decision:response.decision};
    }finally{clearTimeout(id);}
  }catch{return {decision:"pending",reason:"free_model_unavailable"};}
}
async function finish(id: string,state: string,urls: string[]|null=null) {
  return await sqlRpc("fam_finish_photo_batch",{p_batch_id:id,p_state:state,p_public_urls:urls});
}
async function processBatch(batch: Record<string,any>) {
  const id=batch?.id,owner=batch?.owner_id,listingId=batch?.listing_id;
  if(!UUID.test(String(id||""))||!UUID.test(String(owner||""))||!UUID.test(String(listingId||"")))
    return "invalid_job";
  const paths=batch.pending_paths,hashes=batch.input_hashes;
  if(!Array.isArray(paths)||paths.length<2||paths.length>5||!Array.isArray(hashes)||hashes.length!==paths.length)
    return "invalid_job";
  let published: Array<{path:string,url:string}>=[];
  try {
    const listing=await row("listings","id=eq."+listingId+"&user_id=eq."+owner,"id,user_id,status,school_id,category,title,image_url,photo_status");
    const profile=await row("profiles","id=eq."+owner,"id,role,school_id");
    if(!listing||!profile||listing.status!=="active"||listing.image_url||
       !listing.school_id||listing.school_id!==profile.school_id) {
      await finish(id,"rejected");return "rejected";
    }
    const images: Array<{bytes:Uint8Array,mime:string}>=[];
    for(const path of paths)images.push(await stagedPhoto(path,owner));
    const inspected=await inspectPhotoBatch(images);
    if(!inspected.ok||!inspected.files||inspected.files.some((photo,i)=>photo.sha256!==hashes[i])){
      await finish(id,"rejected");return "rejected";
    }

    const trusted=["school_admin","council_member"].includes(profile.role)&&Boolean(profile.school_id);
    let source="trusted_bypass";
    if(!trusted){
      const prior=await sqlRpc("fam_cached_approved_photo_hashes",{
        p_user_id:owner,p_hashes:hashes,p_policy_version:PHOTO_POLICY_VERSION
      });
      const approved=new Set(Array.isArray(prior)?prior:[]);
      const prelim=planBatchReview(hashes,approved,FREE_VERIFIED&&FREE_ENDPOINT&&FREE_TOKEN.length>=16?1:0);
      if(prelim.action==="reject") {await finish(id,"rejected");return "rejected";}
      if(prelim.action==="pending_budget"){await finish(id,"pending_budget");return "pending_budget";}
      if(prelim.action==="review_collage_once"){
        // The server independently creates a collage from all previously unreviewed ORIGINAL files.
        const reviewHashes=prelim.reviewHashes as string[];
        const unknown=images.filter((_,i)=>reviewHashes.includes(hashes[i]));
        const composite=await buildModerationCollage(unknown);
        if(!composite.ok||!composite.reviewBytes){await finish(id,"manual_review");return "manual_review";}
        const permitted=await sqlRpc("fam_claim_free_photo_review_slot",{});
        if(permitted!==true){await finish(id,"pending_budget");return "pending_budget";}
        const decision=await freeVisionReview(composite.reviewBytes,listing.title,listing.category);
        if(decision.decision==="pending"){await finish(id,"pending_budget");return "pending_budget";}
        if(decision.decision==="reject"){await finish(id,"rejected");return "rejected";}
        if(decision.decision!=="approve"){await finish(id,"manual_review");return "manual_review";}
        source="free_ai";
      } else {
        source="approved_hash_cache";
      }
    }
    const assembled=await buildModerationCollage(images);
    if(!assembled.ok||!assembled.sanitized){await finish(id,"manual_review");return "manual_review";}

    // Reverify trust for privileged accounts in case roles changed mid-job.
    if(source==="trusted_bypass"){
      const refreshed=await row("profiles","id=eq."+owner,"role,school_id");
      if(!refreshed||!["school_admin","council_member"].includes(refreshed.role)||
        refreshed.school_id!==listing.school_id){await finish(id,"manual_review");return "manual_review";}
    }
    published=[];
    for(const photo of assembled.sanitized)
      published.push(await uploadApprovedPhoto(photo.bytes,owner));
    const urls=published.map(p=>p.url);
    if(await finish(id,"approved",urls)!==true)throw new Error("db_commit_failed");
    if(source==="free_ai"){
      await sqlRpc("fam_record_approved_photo_hashes",{
        p_user_id:owner,p_hashes:hashes,p_policy_version:PHOTO_POLICY_VERSION,p_reviewed_via:"ai_review"
      }).catch(()=>{});
    }
    // Best-effort privacy cleanup. Never reuse old private files after publication.
    for(const path of paths)await removeStorageObject("listing-images-pending",path);
    return "approved";
  }catch(error){
    for(const item of published)await removeStorageObject("listings-images",item.path).catch(()=>{});
    console.warn("fam_photo_batch_process_failed",error instanceof Error?error.message:"unknown");
    try{await finish(id,"pending_budget");}catch{}
    return "retry";
  }
}

Deno.serve(async req=>{
  if(req.method!=="POST"||req.headers.has("origin"))return json({ok:false,error:"request_not_allowed"},403);
  if(!BASE||!SECRET||!WORKER_TOKEN||!await validToken(req.headers.get("x-fam-agent-token")||""))
    return json({ok:false,error:"unauthorized"},401);
  try{
    const jobs=await sqlRpc("fam_claim_photo_batches",{p_limit:1});
    if(!Array.isArray(jobs))return json({ok:false,error:"invalid_queue"},502);
    const results=[];
    for(const job of jobs)results.push(await processBatch(job));
    return json({ok:true,claimed:jobs.length,results});
  }catch(error){
    console.warn("fam_photo_batch_worker_failed",error instanceof Error?error.name:"unknown");
    return json({ok:false,error:"temporary_error"},503);
  }
});
