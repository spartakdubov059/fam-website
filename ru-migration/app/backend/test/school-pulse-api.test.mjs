import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSchoolPulseApi } from '../services/school-pulse-api.mjs';

const pollId = '11111111-1111-4111-8111-111111111111';
const student = { id: 'student-a', school_id: 'school-a', role: 'student' };
function request(method, url, body, token = 'user') {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method; req.url = url; req.headers = { authorization: `Bearer ${token}` };
  return req;
}
function api({ role = 'student', repository = {}, authenticated = true } = {}) {
  return createSchoolPulseApi({
    authenticate: async () => authenticated ? { issuer: 'issuer', subject: 'subject' } : null,
    resolveActor: async () => authenticated ? { ...student, role } : null,
    repository,
    now: () => Date.parse('2027-01-01T00:00:00.000Z'),
  });
}

test('pulse feed is authenticated and requests only the actor school and own vote identity', async () => {
  let lookup;
  const handler = api({ repository: { listSchoolPulse: async (...args) => { lookup = args; return { announcements: [], polls: [] }; } } });
  const response = await handler(request('GET', '/api/v1/pulse'));
  assert.equal(response.status, 200);
  assert.deepEqual(lookup, ['school-a', 'student-a']);
  assert.equal((await api({ authenticated: false })(request('GET', '/api/v1/pulse'))).status, 401);
  assert.equal((await api({ authenticated: false })(request('POST', '/api/v1/pulse/polls', {}))).status, 401);
});

test('only same-school trusted staff can publish bounded announcements and polls', async () => {
  const calls = [];
  const repository = {
    publishSchoolAnnouncement: async value => { calls.push(['announcement', value]); return { ok: true, id: 'announcement-id' }; },
    publishSchoolPoll: async value => { calls.push(['poll', value]); return { ok: true, id: 'poll-id' }; },
  };
  const studentResponse = await api({ repository })(request('POST', '/api/v1/pulse/announcements', { title: 'Новость', body: 'Встреча состоится в пятницу' }));
  assert.equal(studentResponse.status, 403);
  const handler = api({ role: 'council_member', repository });
  const announcement = await handler(request('POST', '/api/v1/pulse/announcements', { title: 'Встреча', body: 'Приходите на праздник', kind: 'open_event', event_starts_at: '2027-01-03T12:00:00.000Z', school_id: 'other-school' }));
  assert.equal(announcement.status, 201);
  assert.deepEqual(calls[0][1], { schoolId: 'school-a', authorId: student.id, title: 'Встреча', body: 'Приходите на праздник', kind: 'open_event', eventStartsAt: '2027-01-03T12:00:00.000Z' });
  const poll = await handler(request('POST', '/api/v1/pulse/polls', { question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика'] }));
  assert.equal(poll.status, 201);
  assert.deepEqual(calls[1][1], { schoolId: 'school-a', authorId: student.id, question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика'], closesAt: '2027-01-08T00:00:00.000Z' });
  const bad = await handler(request('POST', '/api/v1/pulse/polls', { question: 'Какую книгу обсудим?', options: ['Один', ' один '] }));
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 2);
});

test('poll vote input is bounded and repository enforces school, expiry, and one vote', async () => {
  const calls = [];
  const handler = api({ repository: { voteSchoolPoll: async input => { calls.push(input); return { ok: true }; } } });
  const voted = await handler(request('POST', `/api/v1/pulse/polls/${pollId}/votes`, { choice_index: 1 }));
  assert.equal(voted.status, 201);
  assert.deepEqual(calls, [{ pollId, schoolId: 'school-a', userId: student.id, choiceIndex: 1 }]);
  assert.equal((await handler(request('POST', `/api/v1/pulse/polls/${pollId}/votes`, { choice_index: 4 }))).status, 400);
  const denied = api({ repository: { voteSchoolPoll: async () => ({ ok: false, code: 'already_voted' }) } });
  assert.equal((await denied(request('POST', `/api/v1/pulse/polls/${pollId}/votes`, { choice_index: 0 }))).status, 409);
});
