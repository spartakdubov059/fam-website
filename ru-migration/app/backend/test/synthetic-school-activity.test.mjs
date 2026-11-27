import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifySyntheticSchoolActivity as verify} from '../../../compat/verify-synthetic-school-activity.mjs';
function fixture(){
  const metadata={profiles:[{user_id:'synthetic-a',school_id:'synthetic-school'},{user_id:'synthetic-b',school_id:'synthetic-school'},{user_id:'synthetic-c',school_id:'synthetic-other'}],
    listings:[{id:'synthetic-event',user_id:'synthetic-a',school_id:'synthetic-school',image_key:''},{id:'synthetic-ordinary',user_id:'synthetic-a',school_id:'synthetic-school',image_key:''}],
    ideas:[],messages:[],pending_messages:[],favorites:[],media:[],idea_images:[]};
  const stamp='2026-11-24T12:00:00.000Z',end='2026-11-25T12:00:00.000Z';
  const source={
    listing_event_fields:[{id:'synthetic-event',is_event:true,event_date:'2026-11-25',event_time:'10:00',event_type:'limited',max_seats:1},{id:'synthetic-ordinary',is_event:false,event_date:'',event_time:'',event_type:'',max_seats:0}],
    event_registrations:[{event_id:'synthetic-event',user_id:'synthetic-b',school_id:'synthetic-school',status:'confirmed',created_at:stamp}],
    event_occupancy:[{event_id:'synthetic-event',taken:1}],
    announcements:[{announcement_id:'synthetic-news',school_id:'synthetic-school',author_id:'synthetic-a',title:'synthetic:news',body:'synthetic:body',kind:'news',event_starts_at:null,published_at:stamp,expires_at:end}],
    polls:[{poll_id:'synthetic-poll',school_id:'synthetic-school',author_id:'synthetic-a',question:'synthetic:question',options:['synthetic:yes','synthetic:no'],created_at:stamp,closes_at:end}],
    votes:[{poll_id:'synthetic-poll',voter_id:'synthetic-b',school_id:'synthetic-school',choice_index:1,created_at:stamp}]
  };
  return {metadata,source,target:JSON.parse(JSON.stringify(source))};
}
const cases=[
["exact activity matches",()=>{},"SYNTHETIC_SCHOOL_ACTIVITY_MATCH"],
["row ordering is irrelevant",f=>f.target.listing_event_fields.reverse(),"SYNTHETIC_SCHOOL_ACTIVITY_MATCH"],
["missing event field coverage",f=>f.target.listing_event_fields.pop(),"LISTING_EVENT_COVERAGE"],
["invalid event time",f=>f.target.listing_event_fields[0].event_time="25:00","INVALID_EVENT_FIELDS"],
["event time change",f=>f.target.listing_event_fields[0].event_time="11:00","ACTIVITY_MISMATCH"],
["event capacity change",f=>f.target.listing_event_fields[0].max_seats=2,"ACTIVITY_MISMATCH"],
["duplicate registration",f=>f.target.event_registrations.push({...f.target.event_registrations[0]}),"DUPLICATE_ACTIVITY_KEY"],
["cross school registration",f=>f.target.event_registrations[0].user_id="synthetic-c","INVALID_EVENT_REGISTRATION"],
["organizer cannot register",f=>f.target.event_registrations[0].user_id="synthetic-a","INVALID_EVENT_REGISTRATION"],
["missing occupancy",f=>f.target.event_occupancy=[],"MISSING_OCCUPANCY"],
["corrupt occupancy",f=>f.target.event_occupancy[0].taken=2,"OCCUPANCY_MISMATCH"],
["changed valid registration and occupancy",f=>{f.target.event_registrations[0].status="cancelled";f.target.event_occupancy[0].taken=0;},"ACTIVITY_MISMATCH"],
["lost announcement",f=>f.target.announcements=[],"ACTIVITY_MISMATCH"],
["announcement scope mismatch",f=>f.target.announcements[0].author_id="synthetic-c","INVALID_ANNOUNCEMENT"],
["changed expiry",f=>f.target.announcements[0].expires_at="2026-11-26T12:00:00.000Z","ACTIVITY_MISMATCH"],
["reordered poll options",f=>f.target.polls[0].options.reverse(),"ACTIVITY_MISMATCH"],
["missing poll",f=>f.target.polls=[],"INVALID_VOTE"],
["duplicate vote",f=>f.target.votes.push({...f.target.votes[0]}),"DUPLICATE_ACTIVITY_KEY"],
["vote option out of bounds",f=>f.target.votes[0].choice_index=2,"INVALID_VOTE"],
["cross school vote",f=>f.target.votes[0].voter_id="synthetic-c","INVALID_VOTE"],
["valid vote changed",f=>f.target.votes[0].choice_index=0,"ACTIVITY_MISMATCH"],
["lost vote",f=>f.target.votes=[],"ACTIVITY_MISMATCH"],
["vote after close",f=>f.target.votes[0].created_at="2026-11-26T00:00:00.000Z","INVALID_VOTE"],
["untrusted payload rejected",f=>f.target.polls[0].question="raw","INVALID_POLL"],
["source invalid too",f=>f.source.votes[0].choice_index=-1,"INVALID_VOTE"]
];
for(const [name,mutate,code] of cases)test(name,()=>{const f=fixture();mutate(f);const result=verify(f.metadata,f.source,f.target);assert.equal(result.code,code);assert.equal(result.ok,code==='SYNTHETIC_SCHOOL_ACTIVITY_MATCH');if(result.ok){assert.equal(result.counts.votes,1);assert.equal(result.live_cutover_authorized,false);}});

// Far-future synthetic dates keep TTL-managed rows present in long-lived local CI fixtures.
test('accepts explicitly bounded future synthetic pulse fixtures for TTL-independent CI',()=>{const f=fixture();for(const side of ['source','target']){for(const row of f[side].announcements){row.published_at='2099-11-24T12:00:00.000Z';row.expires_at='2099-11-25T12:00:00.000Z';}for(const row of f[side].polls){row.created_at='2099-11-24T12:00:00.000Z';row.closes_at='2099-11-25T12:00:00.000Z';}for(const row of f[side].votes)row.created_at='2099-11-24T12:00:00.000Z';}assert.equal(verify(f.metadata,f.source,f.target).ok,true);});
