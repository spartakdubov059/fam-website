import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticMigrationPlan, verifySyntheticMigrationPackage } from './synthetic-migration-runner.mjs';

test('synthetic migration runner rejects non-synthetic and mismatched snapshots', () => {
  assert.deepEqual(createSyntheticMigrationPlan({}),
    { ok: false, code: 'INVALID_MIGRATION_PLAN_INPUT', live_cutover_authorized: false });
  const input = {
    source: { snapshot_id: 'real-production' },
    target: { snapshot_id: 'real-production' },
    restored: { snapshot_id: 'real-production' },
    inventory: { snapshot_id: 'real-production' },
    objects: [],
    state: {},
    profiles: [],
  };
  assert.deepEqual(createSyntheticMigrationPlan(input),
    { ok: false, code: 'NON_SYNTHETIC_SNAPSHOT', live_cutover_authorized: false });
});

test('synthetic migration package verifier rejects untrusted inputs and digest mismatch', () => {
  assert.deepEqual(verifySyntheticMigrationPackage(null, '0'.repeat(64)),
    { ok: false, code: 'INVALID_MIGRATION_PACKAGE_INPUT', live_cutover_authorized: false });
  assert.deepEqual(verifySyntheticMigrationPackage(Buffer.from('{}'), '1'.repeat(64)),
    { ok: false, code: 'MIGRATION_PACKAGE_DIGEST_MISMATCH', live_cutover_authorized: false });
});
