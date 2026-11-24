// Synthetic-only offline structural rehearsal. No IO, database, cloud, or credentials.
// Matching identifiers do not prove ownership of a real Yandex identity.
export function verifySyntheticAccountRehearsal(source, target) {
  const reject = code => ({ ok: false, code });
  const id = value => typeof value === 'string' && /^synthetic-[a-z0-9-]{1,64}$/.test(value);
  const shape = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
  const sourceKeys = ['user_id', 'school_id', 'role', 'active'];
  const targetKeys = [...sourceKeys, 'issuer', 'subject'];
  const validProfile = row => id(row.user_id) && id(row.school_id) &&
    typeof row.role === 'string' && /^[a-z_]{1,32}$/.test(row.role) && typeof row.active === 'boolean';
  if (!Array.isArray(source) || !Array.isArray(target) || source.length === 0 ||
      source.length > 10000 || target.length > 10000) return reject('INVALID_MANIFEST');
  const sourceById = new Map();
  for (const row of source) {
    if (!shape(row, sourceKeys) || !validProfile(row)) return reject('INVALID_SYNTHETIC_SOURCE');
    if (sourceById.has(row.user_id)) return reject('DUPLICATE_SOURCE_ID');
    sourceById.set(row.user_id, row);
  }
  const targetIds = new Set(), subjects = new Set();
  for (const row of target) {
    if (!shape(row, targetKeys) || !validProfile(row) || row.issuer !== 'https://synthetic.invalid' ||
        !id(row.subject)) return reject('INVALID_SYNTHETIC_TARGET');
    if (targetIds.has(row.user_id)) return reject('DUPLICATE_TARGET_ID');
    if (subjects.has(row.subject)) return reject('DUPLICATE_TARGET_IDENTITY');
    const previous = sourceById.get(row.user_id);
    if (!previous) return reject('UNEXPECTED_TARGET_ACCOUNT');
    if (row.school_id !== previous.school_id || row.role !== previous.role || row.active !== previous.active) {
      return reject('PROFILE_INVARIANT_CHANGED');
    }
    targetIds.add(row.user_id);
    subjects.add(row.subject);
  }
  if (targetIds.size !== sourceById.size) return reject('MISSING_TARGET_ACCOUNT');
  return { ok: true, code: 'SYNTHETIC_PROFILE_REHEARSAL_PASS', count: sourceById.size };
}
