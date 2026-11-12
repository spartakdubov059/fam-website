import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pendingPhotoPath, validateSignedPhotoBatch, sniffImage, validatePhotoBytes,
  inspectPhotoBatch, planBatchReview, sha256Hex, MAX_PHOTOS, MAX_BATCH_BYTES
} from "../../supabase/functions/photo-batch-policy.js";

const uid = "f5a84e7c-75ea-4b5c-94e4-2e3f9a8d5a1b";
const origin = "https://tfacqpljrvfpcrhdovbu.supabase.co";
const signed = (suffix,owner=uid) => origin+"/storage/v1/object/sign/listing-images-pending/"+owner+"/listing_"+owner+"_"+suffix+".jpg?token=abc.def";
const hash = i => i.toString(16).padStart(64, "0");
const png = (w=128,h=128,tag=0) => {
  const bytes = new Uint8Array(28);
  bytes.set([137,80,78,71,13,10,26,10],0);
  bytes.set([0,0,0,13,73,72,68,82],8);
  const view=new DataView(bytes.buffer);
  view.setUint32(16,w,false);view.setUint32(20,h,false);bytes[24]=8;bytes[25]=2;bytes[27]=tag;
  return bytes;
};
const jpg = new Uint8Array([0xff,0xd8,0xff,0xc0,0,11,8,0,100,0,200,3,1,0x11,0,0,0,0]);
test("signed batch URLs are strictly same-owner, private, time-limited and capped at five",()=>{
 assert.equal(MAX_PHOTOS,5);
 assert.ok(pendingPhotoPath(signed("01234567"),uid,origin)?.startsWith(uid+"/listing_"));
 assert.equal(validateSignedPhotoBatch(Array.from({length:5},(_,i)=>signed("01234567"+i)),uid,origin).ok,true);
 assert.equal(validateSignedPhotoBatch(Array.from({length:6},(_,i)=>signed("01234567"+i)),uid,origin).error,"photo_count_limit");
 assert.equal(validateSignedPhotoBatch([signed("01234567"),signed("01234567")],uid,origin).error,"duplicate_pending_path");
 assert.equal(validateSignedPhotoBatch([signed("01234567", "e65ad519-bcb1-4b6b-8514-5e1b2b82a1e9")],uid,origin).ok,false);
 assert.equal(pendingPhotoPath(signed("01234567").replace("?token=abc.def",""),uid,origin),null);
 assert.equal(pendingPhotoPath(signed("01234567").replace(origin,"https://evil.example"),uid,origin),null);
 assert.equal(pendingPhotoPath(signed("01234567").replace("listing-images-pending","listings-images"),uid,origin),null);
});
test("magic signature, claimed MIME and dimensions are all enforced before decode",()=>{
 assert.deepEqual(sniffImage(png()),{mime:"image/png",width:128,height:128});
 assert.deepEqual(sniffImage(jpg),{mime:"image/jpeg",width:200,height:100});
 assert.equal(validatePhotoBytes(png(),"image/png").ok,true);
 assert.equal(validatePhotoBytes(png(),"image/jpeg").error,"invalid_image_signature");
 assert.equal(validatePhotoBytes(png(5000,100),"image/png").error,"invalid_dimensions");
 assert.equal(validatePhotoBytes(png(1,1),"image/png").error,"invalid_dimensions");
 assert.equal(validatePhotoBytes(new Uint8Array(30),"image/png").error,"invalid_image_signature");
});
test("identical file bytes skip duplicate batch upload",async ()=>{
 const one=png();
 const same=one.slice();
 assert.equal((await inspectPhotoBatch([{bytes:one,mime:"image/png"},{bytes:same,mime:"image/png"}])).error,"duplicate_file_content");
 const two=png(128,128,1);
 const inspected=await inspectPhotoBatch([{bytes:one,mime:"image/png"},{bytes:two,mime:"image/png"}]);
 assert.equal(inspected.ok,true);
 assert.notEqual(inspected.files[0].sha256,inspected.files[1].sha256);
 assert.match(await sha256Hex(one),/^[0-9a-f]{64}$/);
 assert.ok(MAX_BATCH_BYTES <= 15 * 1024 * 1024);
});
test("only server-verified exact hashes may skip review; all other photos remain pending when free budget is zero",()=>{
 const a=hash(1),b=hash(2);
 assert.deepEqual(planBatchReview([a],new Set([a]),0),{action:"cached_approved",reviewHashes:[]});
 assert.deepEqual(planBatchReview([a,b],new Set([a]),0),{action:"pending_budget",reviewHashes:[b]});
 assert.deepEqual(planBatchReview([a,b],new Set([a]),1),{action:"review_collage_once",reviewHashes:[b]});
 assert.equal(planBatchReview([a,b],new Set(),-1).action,"pending_budget");
 assert.equal(planBatchReview([a,a],new Set(),1).action,"reject");
 assert.equal(planBatchReview([a,b],new Set(),NaN).action,"pending_budget");
});
test("server collage decodes originals and outputs only one sanitized JPEG, never trusts a client collage",()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
 const code=readFileSync(resolve(root,"supabase/functions/photo-batch-collage.ts"),"utf8");
 assert.match(code,/import \{ Image \} from "npm:imagescript@3\.13\.1"/);
 assert.match(code,/inspectPhotoBatch\(files\)/);
 assert.match(code,/Image\.decode\(file\.bytes\)/);
 assert.match(code,/decoded\.encodeJPEG/);
 assert.match(code,/collage\.encodeJPEG/);
 assert.doesNotMatch(code,/api\.openai\.com|fetch\(|data:image/);
});
