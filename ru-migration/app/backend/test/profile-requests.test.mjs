import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
import { requestSchoolProfile } from '../services/request-school-profile.mjs';

test('school profile request accepts catalog schools and enforces participant-specific fields', async () => {
  let record;
  const repository = { createSchoolProfileRequest: async value => { record = value; return { ok: true, status: 'pending', request_id: 'request-id' }; } };
  const result = await requestSchoolProfile({ identity: { issuer: 'https://login.yandex.ru', subject: '123456' },
    input: { school_id: 'lyceum_3', first_name: ' Аня ', last_name: 'Иванова', class_name: '8 а', role: 'school_admin' }, repository });
  assert.deepEqual(result, { ok: true, status: 'pending', request_id: 'request-id' });
  assert.deepEqual(record, { issuer: 'https://login.yandex.ru', subject: '123456', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'student', staff_position: '' });
  assert.equal(Object.hasOwn(record, 'role'), false);
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 's' }, input: { school_id: 'made-up', first_name: 'А', last_name: 'Б', class_name: '8А' }, repository })).code, 'invalid_profile_request');
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 's' }, input: { school_id: 'lyceum_3', first_name: 'А', last_name: 'Б', class_name: '999А' }, repository })).code, 'invalid_profile_request');
  for (const class_name of ['4А', '12А', '8Д', '8A']) {
    assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 's' }, input: { school_id: 'lyceum_3', first_name: 'А', last_name: 'Б', class_name }, repository })).code, 'invalid_profile_request');
  }
  for (const class_name of ['5А', '9К', '10Б', '11Г']) {
    assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 's' }, input: { school_id: 'lyceum_3', first_name: 'А', last_name: 'Б', class_name }, repository })).ok, true);
  }
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 'parent' }, input: { school_id: 'lyceum_3', first_name: 'Анна', last_name: 'Иванова', person_type: 'parent' }, repository })).ok, true);
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 'staff' }, input: { school_id: 'lyceum_3', first_name: 'Анна', last_name: 'Иванова', person_type: 'school_staff', staff_position: 'Учитель математики' }, repository })).ok, true);
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 'bad-staff' }, input: { school_id: 'lyceum_3', first_name: 'Анна', last_name: 'Иванова', person_type: 'school_staff' }, repository })).code, 'invalid_profile_request');
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 'bad-parent' }, input: { school_id: 'lyceum_3', first_name: 'Анна', last_name: 'Иванова', person_type: 'parent', class_name: '8А' }, repository })).code, 'invalid_profile_request');
});

test('initial school admin bootstrap is one-time, school-scoped, and audited', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('fam_initial_school_admin_bootstrap')) return calls.filter(call => call.text.includes('fam_initial_school_admin_bootstrap')).length === 1 ? [[]] : [[{ school_id: 'gymnasium_4' }]];
    if (text.includes("role = 'school_admin'")) return [[]];
    if (text.includes('FROM fam_user_profiles') && text.includes('issuer =')) return [[]];
    return [[]];
  };
  const repo = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(tx) }));
  const input = { issuer: 'https://login.yandex.ru', subject: '123456789', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    schoolId: 'gymnasium_4', firstName: 'Тест', lastName: 'Администратор' };
  assert.deepEqual(await repo.bootstrapInitialSchoolAdmin(input), { ok: true, user_id: input.userId });
  assert.deepEqual(await repo.bootstrapInitialSchoolAdmin(input), { ok: false, code: 'already_bootstrapped' });
  assert.ok(calls.some(call => call.text.includes("'school_admin'")));
  assert.ok(calls.some(call => call.text.includes("'initial_admin_bootstrap'")));
  for (const value of [input.subject, input.userId, input.schoolId, input.firstName, input.lastName]) {
    assert.equal(calls.some(call => call.text.includes(value)), false, 'identity and profile values stay bound parameters');
  }
  await assert.rejects(repo.bootstrapInitialSchoolAdmin({ ...input, issuer: 'https://attacker.example' }), TypeError);
  await assert.rejects(repo.bootstrapInitialSchoolAdmin({ ...input, schoolId: 'unapproved_school' }), TypeError);
});

test('profile request repository is idempotent and binds Yandex identity values', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('FROM fam_user_profiles')) return [[]];
    if (text.includes('FROM fam_profile_requests')) return calls.filter(call => call.text.includes('FROM fam_profile_requests')).length === 1 ? [[]] : [[{ request_id: 'existing-request', status: 'pending' }]];
    return [[]];
  };
  const sql = Object.assign(async () => [[]], { begin: async work => work(tx) });
  const repo = createYdbListingsRepository(sql);
  const input = { issuer: 'https://login.yandex.ru', subject: '123456', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'student', staff_position: '' };
  const created = await repo.createSchoolProfileRequest(input);
  assert.equal(created.status, 'pending');
  assert.match(created.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(calls.some(call => call.text.includes('UPSERT INTO fam_profile_requests')), true);
  for (const value of Object.values(input).filter(value => value !== '')) assert.equal(calls.some(call => call.text.includes(value)), false, 'user fields stay bound parameters');
  const duplicate = await repo.createSchoolProfileRequest(input);
  assert.deepEqual(duplicate, { ok: true, status: 'pending', request_id: 'existing-request' });
  assert.equal(calls.some(call => call.text.includes('UPSERT INTO fam_profile_requests') && call.values.includes('existing-request')), false);
});

test('profile approval keeps app role student, applies participant type, and clears request PII after school-scoped review', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT status FROM fam_profile_requests')) return [[{ status: 'approved' }]];
    if (text.includes('FROM fam_profile_requests') && text.includes('request_id =')) return [[{ issuer: 'https://login.yandex.ru', subject: '123456', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А', person_type: 'school_staff', staff_position: 'Учитель', status: 'pending' }]];
    if (text.includes('FROM fam_user_profiles')) return [[]];
    return [[]];
  };
  const repo = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(tx) }));
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(await repo.reviewSchoolProfileRequest(id, 'lyceum_3', 'admin-id', 'approve'), true);
  const insert = calls.find(call => call.text.includes('INSERT INTO fam_user_profiles'));
  assert.match(insert.text, /'student'/);
  assert.match(insert.text, /staff_verification_status/);
  assert.doesNotMatch(insert.text, /school_admin/);
  const reviewUpdate = calls.find(call => call.text.includes('UPDATE fam_profile_requests'));
  assert.ok(reviewUpdate.text.includes("first_name = ''") && reviewUpdate.text.includes('status = ?'));
  assert.ok(reviewUpdate.values.includes('admin-id'), 'reviewer identity is retained for an audit trail');
  assert.equal(await repo.reviewSchoolProfileRequest(id, 'gymnasium_4', 'admin-id', 'approve'), false, 'another school cannot approve the request');
  await assert.rejects(repo.reviewSchoolProfileRequest(id, 'lyceum_3', 'admin-id', 'school_admin'), TypeError);
});

test('profile request status is scoped to the authenticated identity and exposes no applicant PII', async () => {
  let query;
  const repo = createYdbListingsRepository((strings, ...values) => {
    query = { text: strings.join('?'), values };
    return Promise.resolve([[{ request_id: 'request-id', school_id: 'lyceum_3', status: 'pending', created_at: '2099-01-01T00:00:00Z' }]]);
  });
  const request = await repo.getSchoolProfileRequest('https://issuer.example', 'student-subject');
  assert.equal(request.status, 'pending');
  assert.ok(query.values.includes('https://issuer.example'));
  assert.ok(query.values.includes('student-subject'));
  assert.match(query.text, /WHERE issuer = \? AND subject = \?/);
  assert.doesNotMatch(query.text, /first_name|last_name|class_name|SELECT \*/);
  await assert.rejects(repo.getSchoolProfileRequest('', 'student-subject'), TypeError);
});
