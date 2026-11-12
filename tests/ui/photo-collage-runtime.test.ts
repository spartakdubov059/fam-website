import { Image } from "npm:imagescript@3.13.1";
import { buildModerationCollage } from "../../supabase/functions/photo-batch-collage.ts";
import { inspectPhotoBatch } from "../../supabase/functions/photo-batch-policy.js";

Deno.test("server collage re-encodes five originals as exactly one correctly sized JPEG",async()=>{
  const photos=[];
  for(let i=0;i<5;i++){
    const original=new Image(128+i*7,96+i*5).fill((0x11223300+i*0x08080800|0xff)>>>0);
    const bytes=await original.encodeJPEG({quality:85,metadata:{},gainMap:false});
    photos.push({bytes,mime:"image/jpeg"});
  }
  const inspected=await inspectPhotoBatch(photos);
  if(!inspected.ok)throw new Error("source_rejected: "+inspected.error);
  const result=await buildModerationCollage(photos);
  if(!result.ok)throw new Error("collage_rejected: "+result.error);
  if(result.sanitized.length!==5||result.photoHashes.length!==5||result.imageCount!==5)
    throw new Error("wrong_image_count");
  const decoded=await Image.decode(result.reviewBytes);
  if(decoded.width!==1536||decoded.height!==1024)throw new Error("wrong_collage_size");
  for(const item of result.sanitized){
    const decoded=await Image.decode(item.bytes);
    if(!decoded.width||!decoded.height)throw new Error("bad_sanitized_image");
  }
});

Deno.test("collage rejects duplicate original bytes instead of making another AI request",async()=>{
  const original=new Image(160,160).fill(0xaabbccff);
  const bytes=await original.encodePNG();
  const result=await buildModerationCollage([{bytes,mime:"image/png"},{bytes:bytes.slice(),mime:"image/png"}]);
  if(result.ok||result.error!=="duplicate_file_content")throw new Error("duplicate_not_rejected");
});
