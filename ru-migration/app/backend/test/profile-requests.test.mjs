import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';
import { requestSchoolProfile } from '../services/request-school-profile.mjs';

test('school profile request accepts only catalog schools and bounded student fields', async () => {
  let record;
  const repository = { createSchoolProfileRequest: async value => { record = value; return { ok: true, status: 'pending', request_id: 'request-id' }; } };
  const result = await requestSchoolProfile({ identity: { issuer: 'https://login.yandex.ru', subject: '123456' },
    input: { school_id: 'lyceum_3', first_name: ' Аня ', last_name: 'Иванова', class_name: '8 а', role: 'school_admin' }, repository });
  assert.deepEqual(result, { ok: true, status: 'pending', request_id: 'request-id' });
  assert.deepEqual(record, { issuer: 'https://login.yandex.ru', subject: '123456', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' });
  assert.equal(Object.hasOwn(record, 'role'), false);
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 's' }, input: { school_id: 'made-up', first_name: 'А', last_name: 'Б', class_name: '8А' }, repository })).code, 'invalid_profile_request');
  assert.equal((await requestSchoolProfile({ identity: { issuer: 'i', subject: 's' }, input: { school_id: 'lyceum_3', first_name: 'А', last_name: 'Б', class_name: '999А' }, repository })).code, 'invalid_profile_request');
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
  const input = { issuer: 'https://login.yandex.ru', subject: '123456', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' };
  const created = await repo.createSchoolProfileRequest(input);
  assert.equal(created.status, 'pending');
  assert.match(created.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(calls.some(call => call.text.includes('UPSERT INTO fam_profile_requests')), true);
  for (const value of Object.values(input)) assert.equal(calls.some(call => call.text.includes(value)), false, 'user fields stay bound parameters');
  const duplicate = await repo.createSchoolProfileRequest(input);
  assert.deepEqual(duplicate, { ok: true, status: 'pending', request_id: 'existing-request' });
  assert.equal(calls.some(call => call.text.includes('UPSERT INTO fam_profile_requests') && call.values.includes('existing-request')), false);
});

test('profile approval creates only a student profile and clears request PII after school-scoped review', async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join('?'); calls.push({ text, values });
    if (text.includes('SELECT status FROM fam_profile_requests')) return [[{ status: 'approved' }]];
    if (text.includes('FROM fam_profile_requests') && text.includes('request_id =')) return [[{ issuer: 'https://login.yandex.ru', subject: '123456', school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А', status: 'pending' }]];
    if (text.includes('FROM fam_user_profiles')) return [[]];
    return [[]];
  };
  const repo = createYdbListingsRepository(Object.assign(async () => [[]], { begin: async work => work(tx) }));
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(await repo.reviewSchoolProfileRequest(id, 'lyceum_3', 'admin-id', 'approve'), true);
  const insert = calls.find(call => call.text.includes('INSERT INTO fam_user_profiles'));
  assert.match(insert.text, /'student'/);
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
