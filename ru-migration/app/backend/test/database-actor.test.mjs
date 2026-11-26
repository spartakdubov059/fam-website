import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseActorResolver } from '../auth/database-actor.mjs';

test('database actor resolution preserves the existing account UUID and matches only issuer plus subject', async () => {
  const profile = {
    user_id: 'legacy-account-uuid', school_id: 'synthetic-school', role: 'student', active: true,
    first_name: 'Synthetic', last_name: 'Member', class_name: '7A', city: 'Synthetic City', avatar_url: null,
    person_type: 'student', staff_position: null, staff_verification_status: 'not_required',
  };
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    return [[profile]];
  };
  const resolveActor = createDatabaseActorResolver(sql);

  const actor = await resolveActor({
    issuer: 'https://login.yandex.ru', subject: '987654321',
    email: 'same-address-as-an-unrelated-legacy-account@example.test',
  });

  assert.equal(actor.id, profile.user_id, 'Yandex identity resolves to the preserved legacy UUID');
  assert.equal(actor.school_id, profile.school_id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ['https://login.yandex.ru', '987654321']);
  assert.match(calls[0].text, /WHERE issuer = \? AND subject = \?/);
  assert.doesNotMatch(calls[0].text, /email/i, 'email is not an account-link key');
});

test('database actor resolution refuses an identity without issuer and subject', async () => {
  let queries = 0;
  const resolveActor = createDatabaseActorResolver(async () => { queries++; return [[]]; });
  assert.equal(await resolveActor({ email: 'matching@example.test' }), null);
  assert.equal(queries, 0, 'email alone cannot find or merge an account');
});
