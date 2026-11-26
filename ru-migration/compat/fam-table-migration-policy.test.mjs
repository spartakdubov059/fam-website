import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
import { RU_MIGRATION_TABLES } from './synthetic-batch-migration.mjs';
import { RU_TABLE_MIGRATION_POLICY, MIGRATION_DISPOSITIONS,reviewRuTableInventory } from './fam-table-migration-policy.mjs';
const root=new URL('../app/backend/schema/',import.meta.url);

test('every actual YQL CREATE TABLE has a unique reviewed disposition; no missing or invented table',()=>{
 const tables=readdirSync(root).filter(f=>f.endsWith('.yql')).flatMap(f=>[...readFileSync(new URL(f,root),'utf8').replace(/^\s*--.*$/gm,'').matchAll(/\bCREATE\s+TABLE\s+(fam_[a-z0-9_]+)\s*\(/gi)].map(m=>m[1]));
 assert.equal(tables.length,40);
 assert.deepEqual([...tables].sort(),[...RU_MIGRATION_TABLES].sort());
 assert.deepEqual(Object.keys(RU_TABLE_MIGRATION_POLICY).sort(),[...tables].sort());
 const result=reviewRuTableInventory(tables);
 assert.equal(result.ok,true);
 assert.equal(result.live_cutover_authorized,false);
 for(const row of result.tables){assert.ok(MIGRATION_DISPOSITIONS.includes(row.disposition));assert.ok(row.required_review.length>30);}
});
test('unknown, duplicate and incomplete inventory fails closed',()=>{
 for(const input of [null,[],RU_MIGRATION_TABLES.slice(1),[...RU_MIGRATION_TABLES.slice(1),RU_MIGRATION_TABLES[1]],[...RU_MIGRATION_TABLES.slice(1),'fam_unknown']])assert.equal(reviewRuTableInventory(input).code,'TABLE_INVENTORY_UNCLASSIFIED');
});
test('authentication state, deletion intent, safety locks and derived indexes cannot be blindly copied or reset',()=>{
 const p=RU_TABLE_MIGRATION_POLICY;
 for(const name of ['fam_role_email_verifications','fam_step_up_email_challenges'])assert.equal(p[name].disposition,'reauthorize');
 for(const name of ['fam_user_profiles','fam_account_deletion_jobs','fam_account_deletion_requests','fam_account_suspensions','fam_initial_school_admin_bootstrap','fam_pending_media','fam_submission_quotas'])assert.equal(p[name].disposition,'reconcile');
 for(const name of ['fam_event_occupancy','fam_account_deletion_open','fam_account_suspension_open'])assert.equal(p[name].disposition,'derive');
 for(const name of ['fam_agent_tasks','fam_agent_inspector_signals','fam_agent_daily_digest_tasks','fam_site_error_digest_tasks'])assert.equal(p[name].disposition,'restart_controlled');
 assert.equal(p.fam_messages.disposition,'retain_reviewed');
 assert.equal(p.fam_pending_messages.disposition,'retain_reviewed');
 assert.equal(reviewRuTableInventory(RU_MIGRATION_TABLES).live_cutover_authorized,false);
});
