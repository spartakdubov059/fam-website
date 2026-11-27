import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';

const driver = new Driver('grpc://127.0.0.1:2136/local');
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => {
    const statement = client(strings, ...values);
    statement.on('error', () => {});
    return statement;
  };
  sql.begin = client.begin.bind(client);
  const repository = createYdbListingsRepository(sql);
  const identities = [
    { issuer: 'https://login.yandex.ru', subject: '12345678901234567890',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', schoolId: 'gymnasium_4', firstName: 'Синтетический', lastName: 'Администратор' },
    { issuer: 'https://login.yandex.ru', subject: '12345678901234567891',
      userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', schoolId: 'gymnasium_4', firstName: 'Второй', lastName: 'Кандидат' },
  ];
  const attempts = await Promise.allSettled(identities.map(identity => repository.bootstrapInitialSchoolAdmin(identity)));
  const created = attempts.flatMap((attempt, index) => attempt.status === 'fulfilled' && attempt.value?.ok
    ? [{ identity: identities[index], result: attempt.value }] : []);
  assert.equal(created.length, 1, 'only one concurrent identity can become the first school administrator');
  const identity = created[0].identity;
  assert.deepEqual(created[0].result, { ok: true, user_id: identity.userId });
  assert.deepEqual(await repository.bootstrapInitialSchoolAdmin(identity),
    { ok: false, code: 'already_bootstrapped' }, 'a replay cannot provision a second administrator');
  const profileRows = await sql`SELECT user_id, role, active FROM fam_user_profiles
    WHERE school_id = ${identity.schoolId} AND role = 'school_admin' AND active = true;`;
  assert.equal(profileRows?.[0]?.length, 1, 'the school has exactly one active admin after the race');
  assert.equal(profileRows?.[0]?.[0]?.user_id, identity.userId);
  const markerRows = await sql`SELECT user_id FROM fam_initial_school_admin_bootstrap WHERE school_id = ${identity.schoolId} LIMIT 1;`;
  assert.equal(markerRows?.[0]?.[0]?.user_id, identity.userId);
  const auditRows = await sql`SELECT action, previous_role FROM fam_school_admin_audit
    WHERE school_id = ${identity.schoolId} AND target_id = ${identity.userId}
      AND action = 'initial_admin_bootstrap';`;
  assert.deepEqual(auditRows?.[0], [{ action: 'initial_admin_bootstrap', previous_role: 'none' }],
    'the bootstrap must create exactly one matching audit entry, independent of prior role-change audit rows');
  console.log('YDB_SYNTHETIC_INITIAL_ADMIN_BOOTSTRAP_PASS');
} finally {
  await driver.close();
}
