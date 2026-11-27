import { verifySyntheticAccountRehearsal } from './verify-synthetic-account-rehearsal.mjs';
import { verifySyntheticContentRehearsal } from './verify-synthetic-content-rehearsal.mjs';

// Compare normalized synthetic metadata, not raw content or production records.
// Never return row values, identifiers, or material from either manifest.
const reject = (code, stage) => ({ ok: false, code, stage });
const canonicalRows = rows => rows.map(row => JSON.stringify(
  Object.keys(row).sort().map(key => [key, row[key]])
)).sort();

function sameRows(left, right) {
  if (left.length !== right.length) return false;
  const a = canonicalRows(left), b = canonicalRows(right);
  return a.every((value, index) => value === b[index]);
}

export function verifySyntheticMigrationReconciliation(input) {
  const fields = ['sourceAccounts', 'targetAccounts', 'sourceContent', 'targetContent'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || !fields.every(key => Object.hasOwn(input,key))) {
    return reject('INVALID_RECONCILIATION_INPUT', 'input');
  }
  const { sourceAccounts, targetAccounts, sourceContent, targetContent } = input;
  const accounts = verifySyntheticAccountRehearsal(sourceAccounts,targetAccounts);
  if (!accounts.ok) return reject(accounts.code,'accounts');

  const source = verifySyntheticContentRehearsal(sourceContent);
  if (!source.ok) return reject(source.code,'source_content');
  const target = verifySyntheticContentRehearsal(targetContent);
  if (!target.ok) return reject(target.code,'target_content');

  const projection = rows => rows.map(({user_id,school_id})=>({user_id,school_id}));
  if (!sameRows(projection(sourceAccounts),sourceContent.profiles)) {
    return reject('SOURCE_ACCOUNT_CONTENT_MISMATCH','source_content');
  }
  if (!sameRows(projection(targetAccounts),targetContent.profiles)) {
    return reject('TARGET_ACCOUNT_CONTENT_MISMATCH','target_content');
  }

  for (const table of Object.keys(source.counts)) {
    if (!sameRows(sourceContent[table],targetContent[table])) {
      return reject('CONTENT_METADATA_MISMATCH',table);
    }
  }
  return {ok:true,code:'SYNTHETIC_MIGRATION_RECONCILIATION_PASS',accounts:accounts.count,counts:source.counts};
}
