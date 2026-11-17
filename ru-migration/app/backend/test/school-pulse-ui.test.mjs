import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeSchoolPulse } from '../../web/pulse.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}
function fixture() {
  const root = new FakeNode('section');
  return { root, document: { getElementById: id => id === 'ruPulse' ? root : null, createElement: tag => new FakeNode(tag) } };
}

test('school feed renders announcements as text and a student can cast one same-school poll vote', async () => {
  const f = fixture(); const calls = []; let voted = false;
  await initializeSchoolPulse({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'student-a', school_id: 'school-a', role: 'student' } }) };
    if (url === '/api/v1/pulse') return { ok: true, json: async () => ({ ok: true,
      announcements: [{ id: 'notice-a', title: '<img onerror=alert(1)>', body: 'Школьная новость', kind: 'important', published_at: '2027-01-01T10:00:00Z' }],
      polls: [{ id: 'poll-a', question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика'], closes_at: '2099-01-01T00:00:00Z', total_votes: voted ? 1 : 0, my_vote: voted ? 1 : null, counts: null }],
    }) };
    if (url === '/api/v1/pulse/polls/poll-a/votes') { voted = true; return { ok: true, status: 201, json: async () => ({ ok: true, voted: true }) }; }
    throw new Error(`unexpected URL ${url}`);
  } });
  assert.equal(f.root.children[1].textContent, '');
  const feed = f.root.children[2];
  const notice = feed.children[0];
  assert.equal(notice.children[1].textContent, '<img onerror=alert(1)>');
  assert.equal(notice.children[1].children.length, 0);
  const poll = feed.children[1];
  const firstVote = poll.children[2].children[0].children[0];
  await firstVote.listeners.click();
  assert.equal(calls.find(call => call.url.endsWith('/votes')).init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/votes')).init.body), { choice_index: 0 });
  const updatedPoll = f.root.children[2].children[1];
  assert.ok(updatedPoll.children[2].children.every(option => option.children[0].disabled), 'a submitted vote is not offered a second time');
});

test('school feed is private for guests and publisher controls appear only for trusted school roles', async () => {
  const guest = fixture();
  await initializeSchoolPulse({ ...guest, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.match(guest.root.children[1].textContent, /Войдите через Яндекс ID/);
  assert.equal(guest.root.children[2].children[0].href, '/auth/yandex/start');

  const student = fixture();
  await initializeSchoolPulse({ ...student, fetchImpl: async url => url === '/api/v1/me'
    ? { ok: true, json: async () => ({ ok: true, profile: { id: 'student', school_id: 'school-a', role: 'student' } }) }
    : { ok: true, json: async () => ({ ok: true, announcements: [], polls: [] }) } });
  assert.equal(student.root.children[2].children.some(node => node.className === 'ru-pulse-publish'), false);

  const admin = fixture();
  const requests = [];
  await initializeSchoolPulse({ ...admin, fetchImpl: async (url, init = {}) => {
    requests.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'admin', school_id: 'school-a', role: 'school_admin' } }) };
    if (url === '/api/v1/pulse') return { ok: true, json: async () => ({ ok: true, announcements: [], polls: [] }) };
    if (url === '/api/v1/pulse/announcements') return { ok: true, status: 201, json: async () => ({ ok: true }) };
    throw new Error(`unexpected URL ${url}`);
  } });
  const panel = admin.root.children[2].children.find(node => node.className === 'ru-pulse-publish');
  const form = panel.children[1];
  form.children[0].value = 'Новость школы'; form.children[1].value = 'В пятницу будет собрание';
  await form.listeners.submit({ preventDefault() {} });
  const sent = requests.find(call => call.url === '/api/v1/pulse/announcements');
  assert.deepEqual(Object.keys(JSON.parse(sent.init.body)).sort(), ['body', 'event_starts_at', 'kind', 'title']);
  assert.equal(JSON.parse(sent.init.body).school_id, undefined, 'the browser cannot choose announcement school or author');
});
