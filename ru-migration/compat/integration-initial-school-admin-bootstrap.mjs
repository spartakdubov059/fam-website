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
  const identity = { issuer: 'https://login.yandex.ru', subject: '12345678901234567890',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', schoolId: 'gymnasium_4', firstName: 'Синтетический', lastName: 'Администратор' };
  assert.deepEqual(await repository.bootstrapInitialSchoolAdmin(identity), { ok: true, user_id: identity.userId });
  assert.deepEqual(await repository.bootstrapInitialSchoolAdmin({ ...identity, userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    { ok: false, code: 'already_bootstrapped' });
  const profileRows = await sql`SELECT role, active FROM fam_user_profiles
    WHERE issuer = ${identity.issuer} AND subject = ${identity.subject} LIMIT 1;`;
  assert.deepEqual(profileRows?.[0]?.[0], { role: 'school_admin', active: true });
  const markerRows = await sql`SELECT user_id FROM fam_initial_school_admin_bootstrap WHERE school_id = ${identity.schoolId} LIMIT 1;`;
  assert.equal(markerRows?.[0]?.[0]?.user_id, identity.userId);
  const auditRows = await sql`SELECT action, previous_role FROM fam_school_admin_audit WHERE target_id = ${identity.userId} LIMIT 1;`;
  assert.deepEqual(auditRows?.[0]?.[0], { action: 'initial_admin_bootstrap', previous_role: 'none' });
  console.log('YDB_SYNTHETIC_INITIAL_ADMIN_BOOTSTRAP_PASS');
} finally {
  await driver.close();
}
