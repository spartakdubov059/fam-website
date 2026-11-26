const exactKeys = (value, keys) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

export function evaluateFamCutoverReadiness(input) {
  const fail = (blockers) => ({ ok: false, code: 'CUTOVER_NOT_AUTHORIZED', live_cutover_authorized: false, blockers });
  if (!exactKeys(input, [
    'source_migration_count',
    'ru_schema_table_count',
    'ci_green',
    'independent_security_review',
    'mobile_audit',
    'operational_reconciliation',
    'legacy_identity_proofs',
    'yandex_identity_proofs',
    'cloud_infrastructure_configured',
    'owner_cutover_authorization',
  ])) return fail(['invalid_readiness_manifest']);
  if (!Number.isSafeInteger(input.source_migration_count) || input.source_migration_count < 1
      || !Number.isSafeInteger(input.ru_schema_table_count) || input.ru_schema_table_count < 1) {
    return fail(['invalid migration inventory']);
  }
  for (const key of [
    'ci_green', 'independent_security_review', 'mobile_audit',
    'operational_reconciliation', 'legacy_identity_proofs', 'yandex_identity_proofs',
    'cloud_infrastructure_configured', 'owner_cutover_authorization',
  ]) {
    if (typeof input[key] !== 'boolean') return fail(['invalid_readiness_manifest']);
  }
  const blockers = [];
  if (input.source_migration_count < 90) blockers.push('source migration inventory incomplete');
  if (input.ru_schema_table_count < 40) blockers.push('RU schema inventory incomplete');
  if (!input.ci_green) blockers.push('CI is not green');
  if (!input.independent_security_review) blockers.push('independent security review required');
  if (!input.mobile_audit) blockers.push('mobile audit required');
  if (!input.operational_reconciliation) blockers.push('operational reconciliation required');
  if (!input.legacy_identity_proofs) blockers.push('legacy account ownership proof required');
  if (!input.yandex_identity_proofs) blockers.push('Yandex identity ownership proof required');
  if (!input.cloud_infrastructure_configured) blockers.push('Yandex Cloud infrastructure is not configured');
  if (!input.owner_cutover_authorization) blockers.push('owner cutover authorization is required');
  if (blockers.length) return fail(blockers);
  return {
    ok: true,
    code: 'CUTOVER_AUTHORIZATION_READY',
    live_cutover_authorized: true,
    blockers: [],
  };
}
