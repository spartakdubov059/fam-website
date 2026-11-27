import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySyntheticContentRehearsal } from '../../../compat/verify-synthetic-content-rehearsal.mjs';
const fixture = ()=>({profiles:[{user_id:'synthetic-a',school_id:'synthetic-school'},{user_id:'synthetic-b',school_id:'synthetic-school'},{user_id:'synthetic-c',school_id:'synthetic-other'}],listings:[{id:'synthetic-listing',user_id:'synthetic-a',school_id:'synthetic-school',image_key:'synthetic-photo'}],ideas:[{id:'synthetic-idea',user_id:'synthetic-a',school_id:'synthetic-school'}],messages:[{id:'synthetic-message',sender_id:'synthetic-b',receiver_id:'synthetic-a',school_id:'synthetic-school',listing_id:'synthetic-listing'}],pending_messages:[],favorites:[{user_id:'synthetic-b',listing_id:'synthetic-listing'}],media:[{object_key:'synthetic-photo',user_id:'synthetic-a'},{object_key:'synthetic-idea-photo',user_id:'synthetic-a'}],idea_images:[{idea_id:'synthetic-idea',image_index:0,object_key:'synthetic-idea-photo',user_id:'synthetic-a',school_id:'synthetic-school'}]});
const cases = [
  ["valid manifest", m=>{}, "SYNTHETIC_CONTENT_REHEARSAL_PASS"],
  ["duplicate listing", m=>m.listings.push({...m.listings[0]}), "DUPLICATE_KEY"],
  ["missing listing owner", m=>m.listings[0].user_id='synthetic-missing', "LISTING_OWNER_SCOPE"],
  ["cross-school listing", m=>m.listings[0].school_id='synthetic-other', "LISTING_OWNER_SCOPE"],
  ["foreign listing photo", m=>m.media[0].user_id='synthetic-b', "LISTING_MEDIA_OWNER"],
  ["orphan media", m=>m.media[1].user_id='synthetic-missing', "MISSING_MEDIA_OWNER"],
  ["foreign idea", m=>m.ideas[0].school_id='synthetic-other', "IDEA_OWNER_SCOPE"],
  ["foreign idea photo", m=>m.media[1].user_id='synthetic-b', "IDEA_MEDIA_OWNER_SCOPE"],
  ["orphan favorite", m=>m.favorites[0].listing_id='synthetic-missing', "FAVORITE_SCOPE"],
  ["cross-school favorite", m=>m.favorites[0].user_id='synthetic-c', "FAVORITE_SCOPE"],
  ["cross-school message", m=>m.messages[0].sender_id='synthetic-c', "MESSAGE_SCOPE"],
  ["message missing listing", m=>m.messages[0].listing_id='synthetic-missing', "MESSAGE_SCOPE"],
  ["pending duplicate", m=>m.pending_messages.push({...m.messages[0]}), "MESSAGE_MODERATION_COLLISION"],
  ["extra raw content", m=>m.messages[0].body='synthetic text', "INVALID_SYNTHETIC_ROW"],
  ["non-synthetic identifier", m=>m.profiles[0].user_id='actual-id', "INVALID_SYNTHETIC_ROW"],
  ["empty profiles", m=>m.profiles=[], "EMPTY_PROFILES"]
];
for (const [name,mutate,code] of cases) test(name,()=>{const m=fixture(); mutate(m); const result=verifySyntheticContentRehearsal(m); assert.equal(result.code,code); assert.equal(result.ok,code==='SYNTHETIC_CONTENT_REHEARSAL_PASS'); if(!result.ok) assert.deepEqual(Object.keys(result).sort(),['code','ok']);});
