import { createHash } from 'node:crypto';
import { encodeSyntheticProfileBackup, decodeSyntheticProfileBackup } from './synthetic-profile-backup-envelope.mjs';
import { verifySyntheticMigrationAcceptance } from './verify-synthetic-migration-acceptance.mjs';
import { verifySyntheticInventoryAcceptance } from './verify-synthetic-inventory-acceptance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function createSyntheticMigrationPlan(input) {
  const fail = code => ({ ok: false, code, live_cutover_authorized: false });
  if (!exact(input, ['source', 'target', 'restored', 'inventory', 'objects', 'state', 'profiles'])) {
    return fail('INVALID_MIGRATION_PLAN_INPUT');
  }
  if (typeof input.source?.snapshot_id !== 'string'
      || !/^synthetic-[a-z0-9-]{3,64}$/i.test(input.source.snapshot_id)) {
    return fail('NON_SYNTHETIC_SNAPSHOT');
  }
  if (input.source.snapshot_id !== input.target?.snapshot_id
      || input.source.snapshot_id !== input.restored?.snapshot_id
      || input.source.snapshot_id !== input.inventory?.snapshot_id) {
    return fail('SNAPSHOT_ID_MISMATCH');
  }
  const acceptance = verifySyntheticMigrationAcceptance({
    source: input.source,
    target: input.target,
    restored: input.restored,
  });
  if (!acceptance.ok) return { ok: false, code: acceptance.code, stage: acceptance.stage, live_cutover_authorized: false };
  const inventory = verifySyntheticInventoryAcceptance({
    source: { snapshot: input.source, state: input.state, profiles: input.profiles },
    target: { snapshot: input.target, state: input.state, profiles: input.profiles },
    restored: { snapshot: input.restored, state: input.state, profiles: input.profiles },
    inventory: input.inventory,
  });
  if (!inventory.ok) return { ok: false, code: inventory.code, stage: inventory.stage, live_cutover_authorized: false };
  const archive = encodeSyntheticProfileBackup(input.source, input.objects, input.state, input.profiles);
  if (!archive.ok) return archive;
  const plan = {
    version: 1,
    snapshot_id: input.source.snapshot_id,
    archive_sha256: archive.sha256,
    table_count: 13,
    inventory_tables: inventory.inventory_tables,
    live_cutover_authorized: false,
  };
  const canonical = JSON.stringify(plan);
  return {
    ok: true,
    plan,
    plan_sha256: hash(canonical),
    archive: archive.bytes,
    live_cutover_authorized: false,
  };
}

export function verifySyntheticMigrationPackage(packageBytes, packageSha256) {
  if (!Buffer.isBuffer(packageBytes) || typeof packageSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(packageSha256)) {
    return { ok: false, code: 'INVALID_MIGRATION_PACKAGE_INPUT', live_cutover_authorized: false };
  }
  if (hash(packageBytes) !== packageSha256) {
    return { ok: false, code: 'MIGRATION_PACKAGE_DIGEST_MISMATCH', live_cutover_authorized: false };
  }
  const archive = decodeSyntheticProfileBackup(packageBytes, packageSha256);
  return archive.ok
    ? { ok: true, code: 'SYNTHETIC_MIGRATION_PACKAGE_PASS', live_cutover_authorized: false }
    : archive;
}
