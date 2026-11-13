import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(import.meta.url);
const { photos, MAX_PHOTOS }=require(resolve(root,"listing-gallery.js"));
const url=id=>"https://tfacqpljrvfpcrhdovbu.supabase.co/storage/v1/object/public/listings-images/"+id+".jpg";
test("gallery keeps old listings with one approved photo compatible",()=>{
 assert.deepEqual(photos({image_url:url("one"),photo_status:"approved"}),[url("one")]);
 assert.deepEqual(photos({image_url:null,photo_status:"none"}),[]);
});
test("gallery limits to five unique approved server-published photos",()=>{
 const input=Array.from({length:10},(_,i)=>url(String(i)));
 assert.deepEqual(photos({image_url:input[0],image_urls:[input[0],...input.slice(1)],photo_status:"approved"}),input.slice(0,5));
 assert.equal(MAX_PHOTOS,5);
});
test("pending, rejected and untrusted image URLs are never displayed",()=>{
 for(const state of ["pending","manual_review","rejected","failed"])assert.deepEqual(photos({image_url:url("a"),image_urls:[url("b")],photo_status:state}),[]);
 assert.deepEqual(photos({photo_status:"approved",image_urls:["https://example.com/a.jpg","javascript:alert(1)","https://tfacqpljrvfpcrhdovbu.supabase.co/storage/v1/object/sign/listing-images-pending/u/p?token=x"]}),[]);
});
test("frontend renders multiple approved photos without bypassing the existing single-image upload flow",()=>{
 const html=readFileSync(resolve(root,"index.html"),"utf8");
 assert.match(html,/src="\.\/listing-gallery\.js"/);
 assert.match(html,/FAMGallery\.photos\(listing\)/);
 assert.match(html,/listing-detail-thumb/);
 assert.match(html,/const MULTI_PHOTO_UPLOAD_ENABLED = false/);
 assert.match(html,/const file = uploadAsBatch \? null : \$\("lImage"\)\.files\[0\]/);
});
