import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifySyntheticAttachmentReconciliation as verify } from '../../../compat/verify-synthetic-attachment-reconciliation.mjs';
const fixture = ()=>{const expectedMedia=[{object_key:'synthetic-photo',user_id:'synthetic-a'},{object_key:'synthetic-idea-photo',user_id:'synthetic-b'}];const sourceObjects=expectedMedia.map((row,i)=>({...row,byte_length:10+i,sha256:(i?'b':'a').repeat(64)}));return {expectedMedia,sourceObjects,targetObjects:sourceObjects.map(x=>({...x}))};};
const cases = [
  ["preserves attachment digests and ownership", ()=>{}, "SYNTHETIC_ATTACHMENT_RECONCILIATION_PASS"],
  ["ignores object ordering", f=>f.targetObjects.reverse(), "SYNTHETIC_ATTACHMENT_RECONCILIATION_PASS"],
  ["allows truly empty inventory", f=>{f.expectedMedia=[];f.sourceObjects=[];f.targetObjects=[];}, "SYNTHETIC_ATTACHMENT_RECONCILIATION_PASS"],
  ["rejects missing destination object", f=>f.targetObjects.pop(), "MISSING_TARGET_OBJECT"],
  ["rejects missing source object", f=>f.sourceObjects.pop(), "MISSING_SOURCE_OBJECT"],
  ["rejects duplicate destination object", f=>f.targetObjects.push({...f.targetObjects[0]}), "DUPLICATE_TARGET_OBJECT"],
  ["rejects duplicate reference", f=>f.expectedMedia.push({...f.expectedMedia[0]}), "DUPLICATE_MEDIA_REFERENCE"],
  ["rejects unexpected destination object", f=>f.targetObjects.push({...f.targetObjects[0],object_key:'synthetic-extra'}), "UNEXPECTED_TARGET_OBJECT"],
  ["rejects changed owner", f=>f.targetObjects[0].user_id='synthetic-b', "TARGET_OWNER_MISMATCH"],
  ["rejects source owner mismatch", f=>f.sourceObjects[0].user_id='synthetic-b', "SOURCE_OWNER_MISMATCH"],
  ["rejects changed bytes with same length", f=>f.targetObjects[0].sha256='c'.repeat(64), "ATTACHMENT_BYTES_MISMATCH"],
  ["rejects changed size with same digest", f=>f.targetObjects[0].byte_length++, "ATTACHMENT_BYTES_MISMATCH"],
  ["rejects zero bytes", f=>f.targetObjects[0].byte_length=0, "INVALID_TARGET_OBJECT"],
  ["rejects malformed hash", f=>f.sourceObjects[0].sha256='not-a-digest', "INVALID_SOURCE_OBJECT"],
  ["rejects raw file payload", f=>f.targetObjects[0].bytes='raw', "INVALID_TARGET_OBJECT"],
  ["rejects actual identifiers", f=>f.expectedMedia[0].object_key='real-key', "INVALID_EXPECTED_MEDIA"]
];
for(const [name,mutate,code] of cases) test(name,()=>{const f=fixture();mutate(f);const result=verify(f);assert.equal(result.code,code);if(code==='SYNTHETIC_ATTACHMENT_RECONCILIATION_PASS'){assert.equal(result.ok,true);assert.equal(result.count,f.expectedMedia.length);}else assert.deepEqual(result,{ok:false,code});});

test('actual synthetic byte hashing detects substitution at unchanged size',()=>{
 const f=fixture();
 const first=Buffer.from('synthetic1'), second=Buffer.from('synthetic2');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 f.sourceObjects[0].sha256=hash(first);f.sourceObjects[0].byte_length=first.length;
 f.targetObjects[0].sha256=hash(second);f.targetObjects[0].byte_length=second.length;
 assert.equal(first.length,second.length);
 assert.deepEqual(verify(f),{ok:false,code:'ATTACHMENT_BYTES_MISMATCH'});
});
