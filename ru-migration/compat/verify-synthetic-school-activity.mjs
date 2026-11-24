// Offline, synthetic-only, normalized school activity comparison. No DB import; inconsistent historical rows require review, not deletion.
import { verifySyntheticContentRehearsal } from './verify-synthetic-content-rehearsal.mjs';
export function verifySyntheticSchoolActivity(metadata, source, target) {
  const fail=(code,table)=>({ok:false,code,table});
  const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
  const id=x=>typeof x==='string'&&/^synthetic-[a-z0-9-]{1,64}$/.test(x);
  const dummy=x=>typeof x==='string'&&/^synthetic:[a-zA-Z0-9 _.-]{1,200}$/.test(x);
  const ts=x=>typeof x==='string'&&/^2026-11-(?:24|25|26)T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
  const date=x=>typeof x==='string'&&/^2026-11-(?:24|25|26)$/.test(x);
  const time=x=>typeof x==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x);
  const uint=x=>Number.isSafeInteger(x)&&x>=0&&x<=4294967295;
  if(!verifySyntheticContentRehearsal(metadata).ok)return fail('INVALID_METADATA','input');
  const users=new Map(metadata.profiles.map(x=>[x.user_id,x.school_id]));
  const listings=new Map(metadata.listings.map(x=>[x.id,x]));
  const schema={
    listing_event_fields:['id','is_event','event_date','event_time','event_type','max_seats'],
    event_registrations:['event_id','user_id','school_id','status','created_at'],
    event_occupancy:['event_id','taken'],
    announcements:['announcement_id','school_id','author_id','title','body','kind','event_starts_at','published_at','expires_at'],
    polls:['poll_id','school_id','author_id','question','options','closes_at','created_at'],
    votes:['poll_id','voter_id','school_id','choice_index','created_at']
  };
  const primary={listing_event_fields:['id'],event_registrations:['event_id','user_id'],event_occupancy:['event_id'],announcements:['announcement_id'],polls:['poll_id'],votes:['poll_id','voter_id']};
  const tables=Object.keys(schema);
  function index(manifest){
    if(!exact(manifest,tables))return fail('INVALID_ACTIVITY_MANIFEST','input');
    const maps={};
    for(const t of tables){
      if(!Array.isArray(manifest[t])||manifest[t].length>10000)return fail('INVALID_ACTIVITY_ROWS',t);
      maps[t]=new Map();
      for(const row of manifest[t]){
        if(!exact(row,schema[t])||!primary[t].every(k=>id(row[k])))return fail('INVALID_ACTIVITY_ROWS',t);
        const key=primary[t].map(k=>row[k]).join('|');
        if(maps[t].has(key))return fail('DUPLICATE_ACTIVITY_KEY',t);
        maps[t].set(key,row);
      }
    }
    if(maps.listing_event_fields.size!==listings.size)return fail('LISTING_EVENT_COVERAGE','listing_event_fields');
    for(const e of manifest.listing_event_fields){
      if(!listings.has(e.id)||typeof e.is_event!=='boolean'||!uint(e.max_seats))return fail('INVALID_EVENT_FIELDS','listing_event_fields');
      if(e.is_event){
        if(!date(e.event_date)||!time(e.event_time)||!['open','request','limited'].includes(e.event_type))return fail('INVALID_EVENT_FIELDS','listing_event_fields');
      }else if(e.event_date!==''||e.event_time!==''||!['','open','request','limited'].includes(e.event_type)||e.max_seats!==0)return fail('NON_EVENT_FIELDS_REQUIRE_REVIEW','listing_event_fields');
    }
    const active=new Map();
    for(const r of manifest.event_registrations){
      const event=maps.listing_event_fields.get(r.event_id),listing=listings.get(r.event_id);
      if(!event?.is_event||!listing||listing.user_id===r.user_id||listing.school_id!==r.school_id||users.get(r.user_id)!==r.school_id||
          !['pending','confirmed','cancelled','rejected'].includes(r.status)||!ts(r.created_at))return fail('INVALID_EVENT_REGISTRATION','event_registrations');
      if(['pending','confirmed'].includes(r.status))active.set(r.event_id,(active.get(r.event_id)||0)+1);
    }
    for(const row of manifest.event_occupancy){
      const event=maps.listing_event_fields.get(row.event_id);
      if(!event?.is_event||!uint(row.taken)||row.taken!==(active.get(row.event_id)||0)||
         (event.event_type==='limited'&&event.max_seats>0&&row.taken>event.max_seats))return fail('OCCUPANCY_MISMATCH','event_occupancy');
    }
    for(const [eventId,count] of active)if(count>0&&!maps.event_occupancy.has(eventId))return fail('MISSING_OCCUPANCY','event_occupancy');
    for(const a of manifest.announcements){
      if(!id(a.school_id)||users.get(a.author_id)!==a.school_id||!dummy(a.title)||!dummy(a.body)||
          !['news','important','open_event'].includes(a.kind)||!ts(a.published_at)||!ts(a.expires_at)||a.expires_at<=a.published_at||
          (a.kind==='open_event'?(!ts(a.event_starts_at)||a.expires_at<=a.event_starts_at):a.event_starts_at!==null))return fail('INVALID_ANNOUNCEMENT','announcements');
    }
    for(const q of manifest.polls){
      if(!id(q.school_id)||users.get(q.author_id)!==q.school_id||!dummy(q.question)||!Array.isArray(q.options)||
         q.options.length<2||q.options.length>8||!q.options.every(dummy)||!ts(q.created_at)||!ts(q.closes_at)||q.closes_at<=q.created_at)return fail('INVALID_POLL','polls');
    }
    for(const v of manifest.votes){
      const q=maps.polls.get(v.poll_id);
      if(!q||q.school_id!==v.school_id||users.get(v.voter_id)!==v.school_id||!uint(v.choice_index)||v.choice_index>=q.options.length||
         !ts(v.created_at)||v.created_at<q.created_at||v.created_at>=q.closes_at)return fail('INVALID_VOTE','votes');
    }
    return {ok:true,maps};
  }
  const a=index(source);if(!a.ok)return a;
  const b=index(target);if(!b.ok)return b;
  for(const t of tables){
    if(a.maps[t].size!==b.maps[t].size)return fail('ACTIVITY_MISMATCH',t);
    for(const [key,row] of a.maps[t]){
      const next=b.maps[t].get(key);
      if(!next||JSON.stringify(schema[t].map(k=>row[k]))!==JSON.stringify(schema[t].map(k=>next[k])))return fail('ACTIVITY_MISMATCH',t);
    }
  }
  return {ok:true,code:'SYNTHETIC_SCHOOL_ACTIVITY_MATCH',counts:Object.fromEntries(tables.map(t=>[t,a.maps[t].size])),live_cutover_authorized:false};
}
