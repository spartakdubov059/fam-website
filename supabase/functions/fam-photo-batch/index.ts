// Staging-only endpoint. Do not deploy before the queue migration + worker are tested.
// It never publishes user media or calls paid AI. All photos remain private.
import {
  validateSignedPhotoBatch, inspectPhotoBatch, MAX_PHOTOS, MAX_FILE_BYTES,
  PHOTO_POLICY_VERSION
} from "../photo-batch-policy.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ALLOWED_ORIGINS = new Set([
  "https://spartakdubov059.github.io",
  "https://famru.netlify.app",
  "https://mellifluous-profiterole-48c13b.netlify.app"
]);
function readKey(name: string) {
  const value = Deno.env.get(name) ?? "";
  try { const obj = JSON.parse(value); if (typeof obj?.default === "string") return obj.default; } catch {}
  return value;
}
const SERVICE_KEY = readKey("SUPABASE_SECRET_KEYS")
  || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  || Deno.env.get("SUPABASE_SECRET_KEY") || "";
const PUBLISHABLE_KEY = readKey("SUPABASE_PUBLISHABLE_KEYS")
  || Deno.env.get("SUPABASE_ANON_KEY")
  || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const LEGACY_SERVICE_JWT = SERVICE_KEY.startsWith("eyJ");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errors: Record<string,string> = {
  invalid_pending_photo: "Файлы должны находиться в вашем защищённом хранилище.",
  duplicate_pending_path: "Одинаковый файл выбран несколько раз.",
  duplicate_file_content: "Вы выбрали две одинаковые фотографии.",
  photo_count_limit: "Добавьте от двух до пяти фотографий.",
  total_batch_size_limit: "Фотографии слишком большие.",
  invalid_file_size: "Неверный размер файла.",
  invalid_image_signature: "Разрешены только настоящие JPG, PNG и WebP.",
  invalid_dimensions: "Неверное разрешение фотографии."
};
function response(body: unknown, status=200, origin: string|null=null) {
  const headers: Record<string,string> = { "Content-Type":"application/json; charset=utf-8", "Vary":"Origin",
    "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods":"POST, OPTIONS" };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return new Response(JSON.stringify(body), {status, headers});
}
async function serviceGet(path: string) {
  const headers: Record<string,string> = { "apikey": SERVICE_KEY };
  if (LEGACY_SERVICE_JWT) headers["Authorization"]="Bearer "+SERVICE_KEY;
  const res=await fetch(SUPABASE_URL+"/rest/v1/"+path,{headers});
  const json=await res.json().catch(()=>null);
  return {ok:res.ok, data:json};
}
async function serviceRpc(name: string, body: unknown) {
  const headers: Record<string,string>={ "apikey":SERVICE_KEY, "Content-Type":"application/json" };
  if (LEGACY_SERVICE_JWT) headers["Authorization"]="Bearer "+SERVICE_KEY;
  const res=await fetch(SUPABASE_URL+"/rest/v1/rpc/"+name,{
    method:"POST",headers,body:JSON.stringify(body)
  });
  return {ok:res.ok,data:await res.json().catch(()=>null)};
}

Deno.serve(async req=>{
  const origin=req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin))
    return response({ok:false,error:"origin_not_allowed"},403);
  if (req.method==="OPTIONS") return response({ok:true},200,origin);
  if (req.method!=="POST") return response({ok:false,error:"method_not_allowed"},405,origin);
  if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SERVICE_KEY)
    return response({ok:false,error:"server_not_configured"},503,origin);
  const authorization=req.headers.get("authorization")||"";
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization))
    return response({ok:false,error:"unauthorized"},401,origin);
  try {
    // Always verify actual user with Supabase Auth, not unsigned browser claims.
    const me=await fetch(SUPABASE_URL+"/auth/v1/user",{
      headers:{"apikey":PUBLISHABLE_KEY,"Authorization":authorization}
    });
    if (!me.ok) return response({ok:false,error:"unauthorized"},401,origin);
    const user=await me.json();
    if (!uuid.test(user?.id||"")) return response({ok:false,error:"unauthorized"},401,origin);
    const payload=await req.json().catch(()=>null);
    const listingId=payload?.listing_id;
    const URLs=payload?.image_urls;
    if (!uuid.test(String(listingId||""))) return response({ok:false,error:"invalid_listing"},400,origin);
    if (!Array.isArray(URLs) || URLs.length < 2 || URLs.length > MAX_PHOTOS)
      return response({ok:false,error:"photo_count_limit"},400,origin);
    const checked=validateSignedPhotoBatch(URLs,user.id,SUPABASE_URL);
    if (!checked.ok)
      return response({ok:false,error:checked.error,reason:errors[checked.error||'']},400,origin);

    // Verify the already-text-moderated listing belongs to this exact account.
    const result=await serviceGet("listings?select=id,user_id,status,moderation_status,image_url,photo_status"+
      "&id=eq."+encodeURIComponent(listingId)+"&user_id=eq."+encodeURIComponent(user.id)+"&limit=1");
    const listing=Array.isArray(result.data) ? result.data[0] : null;
    if (!result.ok) return response({ok:false,error:"listing_lookup_failed"},503,origin);
    if (!listing || listing.status!=="active" || listing.image_url ||
       !["approved","none",null].includes(listing.moderation_status))
      return response({ok:false,error:"listing_not_eligible"},403,origin);
    if (listing.photo_status && !["none","failed"].includes(listing.photo_status))
      return response({ok:false,error:"photo_batch_already_submitted"},409,origin);

    const files: Array<{bytes:Uint8Array,mime:string}>=[];
    for (const url of URLs) {
      // Signed private URLs are fetched server-side; a browser-supplied collage is ignored.
      const res=await fetch(url,{redirect:"error"});
      if (!res.ok || Number(res.headers.get("content-length")||0)>MAX_FILE_BYTES)
        return response({ok:false,error:"photo_unavailable"},400,origin);
      const mime=(res.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
      const bytes=new Uint8Array(await res.arrayBuffer());
      files.push({bytes,mime});
    }
    const content=await inspectPhotoBatch(files);
    if (!content.ok) return response({ok:false,error:content.error,reason:errors[content.error||'']},400,origin);
    // Only server-verified paths and hashes enter the private queue.
    const queued=await serviceRpc("fam_enqueue_photo_batch",{
      p_listing_id:listingId,
      p_owner_id:user.id,
      p_pending_paths:checked.paths,
      p_input_hashes:content.files.map(file=>file.sha256),
      p_policy_version:PHOTO_POLICY_VERSION
    });
    if (!queued.ok || typeof queued.data !== "string" || !uuid.test(queued.data)) {
      return response({ok:false,error:"photo_queue_unavailable"},503,origin);
    }
    return response({ok:true,status:"pending",batch_id:queued.data,
      reason:"Фотографии сохранены приватно. Они появятся только после проверки."},202,origin);
  }catch(error){
    console.warn("fam_photo_batch_admission_failed",error instanceof Error?error.name:"unknown");
    return response({ok:false,error:"temporary_error"},503,origin);
  }
});
