import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbSchemaHealthCheck, REQUIRED_RU_TABLES } from '../services/ydb-schema-health.mjs';

function fakeSql({ resultSets = REQUIRED_RU_TABLES.map(() => []) } = {}) {
  const calls = [];
  function sql(strings, ...values) {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(resultSets);
  }
  sql.fragment = (strings, ...values) => ({ strings: [...strings], values });
  sql.identifier = name => ({ identifier: name });
  sql.join = (items, separator) => ({ items, separator });
  return { sql, calls, identifier: name => ({ identifier: name }), fragment: sql.fragment, join: sql.join };
}

test('RU schema health checks all required tables with zero-row probes and returns aggregates only', async () => {
  const { sql, calls, identifier, fragment, join } = fakeSql();
  const result = await createYdbSchemaHealthCheck(sql, { identifier, fragment, join })();
  assert.equal(REQUIRED_RU_TABLES.length, 37);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values[0].items.length, 37);
  assert.deepEqual(result, { ok: true, tables_checked: 37, content_read: false, write_permissions_checked: false });
});

test('RU schema health rejects malformed, duplicate and empty table lists', () => {
  const { sql, identifier, fragment, join } = fakeSql();
  for (const tables of [[], ['fam_good', 'fam_good'], ['other_table'], ['fam_unsafe-name']]) {
    assert.throws(() => createYdbSchemaHealthCheck(sql, { tables, identifier, fragment, join }), /invalid RU schema health configuration/);
  }
});

test('RU schema health propagates YDB errors and rejects incomplete probe results', async () => {
  const { sql, identifier, fragment, join } = fakeSql({ resultSets: [[]] });
  await assert.rejects(createYdbSchemaHealthCheck(sql, { identifier, fragment, join })(), /invalid RU schema probe result/);
  const brokenSql = async () => { throw new Error('synthetic YDB failure'); };
  brokenSql.fragment = (strings, ...values) => ({ strings, values });
  brokenSql.identifier = name => name;
  brokenSql.join = items => items;
  await assert.rejects(createYdbSchemaHealthCheck(brokenSql, { identifier, fragment, join })(), /synthetic YDB failure/);
});
