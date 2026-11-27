// Offline structural rehearsal for normalized synthetic metadata only.
// Any orphan or inconsistent scope is a review blocker, not permission to delete data.
// No database, real identity, media bytes, content, or network operations.
export function verifySyntheticContentRehearsal(manifest) {
  const reject = code => ({ok:false,code});
  const id = x => typeof x === 'string' && /^synthetic-[a-z0-9-]{1,64}$/.test(x);
  const schema = {
    profiles:['user_id','school_id'],
    listings:['id','user_id','school_id','image_key'],
    ideas:['id','user_id','school_id'],
    messages:['id','sender_id','receiver_id','school_id','listing_id'],
    pending_messages:['id','sender_id','receiver_id','school_id','listing_id'],
    favorites:['user_id','listing_id'],
    media:['object_key','user_id'],
    idea_images:['idea_id','image_index','object_key','user_id','school_id']
  };
  const keys = Object.keys(schema);
  const shape = (x,fields) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
    Object.keys(x).length === fields.length && fields.every(k=>Object.hasOwn(x,k));
  if (!shape(manifest,keys)) return reject('INVALID_MANIFEST');
  const primary = {profiles:['user_id'],listings:['id'],ideas:['id'],messages:['id'],pending_messages:['id'],favorites:['user_id','listing_id'],media:['object_key'],idea_images:['idea_id','image_index']};
  const maps = {};
  for (const k of keys) {
    if (!Array.isArray(manifest[k]) || manifest[k].length>10000) return reject('INVALID_MANIFEST');
    maps[k]=new Map();
    for (const row of manifest[k]) {
      if (!shape(row,schema[k]) || !schema[k].every(f=>f==='image_index' ? Number.isSafeInteger(row[f])&&row[f]>=0&&row[f]<=20 : f==='image_key' ? row[f]===''||id(row[f]) : id(row[f]))) return reject('INVALID_SYNTHETIC_ROW');
      const key=primary[k].map(f=>row[f]).join('|');
      if(maps[k].has(key)) return reject('DUPLICATE_KEY');
      maps[k].set(key,row);
    }
  }
  if (!maps.profiles.size) return reject('EMPTY_PROFILES');
  const schoolOf = user => maps.profiles.get(user)?.school_id;
  const owns = (row,school) => !!row && schoolOf(row.user_id)===school;
  for (const m of manifest.media) if (!schoolOf(m.user_id)) return reject('MISSING_MEDIA_OWNER');
  for (const l of manifest.listings) {
    if (!owns(l,l.school_id)) return reject('LISTING_OWNER_SCOPE');
    if(l.image_key && maps.media.get(l.image_key)?.user_id!==l.user_id) return reject('LISTING_MEDIA_OWNER');
  }
  for (const idea of manifest.ideas) if(!owns(idea,idea.school_id)) return reject('IDEA_OWNER_SCOPE');
  for (const a of manifest.idea_images) {
    const idea=maps.ideas.get(a.idea_id);
    if (!idea || idea.user_id!==a.user_id || idea.school_id!==a.school_id || maps.media.get(a.object_key)?.user_id!==a.user_id) return reject('IDEA_MEDIA_OWNER_SCOPE');
  }
  for (const f of manifest.favorites) {
    const listing=maps.listings.get(f.listing_id);
    if(!listing||schoolOf(f.user_id)!==listing.school_id) return reject('FAVORITE_SCOPE');
  }
  for (const k of ['messages','pending_messages']) for(const m of manifest[k]) {
    const listing=maps.listings.get(m.listing_id);
    if (!listing || listing.school_id!==m.school_id || schoolOf(m.sender_id)!==m.school_id || schoolOf(m.receiver_id)!==m.school_id || m.sender_id===m.receiver_id || ![m.sender_id,m.receiver_id].includes(listing.user_id)) return reject('MESSAGE_SCOPE');
    if(k==='pending_messages'&&maps.messages.has(m.id)) return reject('MESSAGE_MODERATION_COLLISION');
  }
  return {ok:true,code:'SYNTHETIC_CONTENT_REHEARSAL_PASS',counts:Object.fromEntries(keys.map(k=>[k,manifest[k].length]))};
}
