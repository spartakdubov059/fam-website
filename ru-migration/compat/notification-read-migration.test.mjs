import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mapLegacyNotificationReads} from './notification-read-migration.mjs';

const uuid='edededed-eded-4ded-8ded-edededed0001';
const source=()=>({user_id:uuid,notification_key:'listing:synthetic-1',read_at:'2026-11-27T12:00:00.000Z'});

test('maps exact legacy notification read fields and preserves timestamp',()=>{
 const result=mapLegacyNotificationReads([source()]);
 assert.equal(result.ok,true);
 assert.equal(result.live_import_authorized,false);
 assert.deepEqual(result.rows,[{user_id:uuid,notification_key:'listing:synthetic-1',read_at:new Date('2026-11-27T12:00:00.000Z')}]);
});

test('rejects malformed, extra, duplicate and overlong source rows',()=>{
 for(const input of [null,{},[null],[{...source(),password:'synthetic'}],[{...source(),user_id:'not-a-uuid'}],
  [{...source(),notification_key:''}],[{...source(),notification_key:'x'.repeat(221)}],
  [{...source(),read_at:'2026-02-30T12:00:00Z'}],[source(),source()],Array.from({length:10001},source)]){
  const result=mapLegacyNotificationReads(input);
  assert.equal(result.ok,false);
  assert.equal(result.live_import_authorized,false);
 }
});

test('field mapper stays aligned with source and YDB notification read schemas',()=>{
 const migration=readFileSync(new URL('../../supabase/migrations/20261110165908_notification_read_states.sql',import.meta.url),'utf8');
 const target=readFileSync(new URL('../app/backend/schema/26_notification_reads.yql',import.meta.url),'utf8');
 for(const field of ['user_id','notification_key','read_at']){
  assert.match(migration,new RegExp(`\\b${field}\\b`,'i'));
  assert.match(target,new RegExp(`\\b${field}\\b`,'i'));
 }
 assert.match(migration,/primary key\s*\(user_id,\s*notification_key\)/i);
 assert.match(target,/PRIMARY KEY\s*\(user_id,\s*notification_key\)/i);
 assert.match(target,/TTL\s*=\s*Interval\("P180D"\) ON read_at/i);
});
