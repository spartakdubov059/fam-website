import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeListingModeration } from '../../web/listing-moderation.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.hidden = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}

function fixture() {
  const panel = new FakeNode('section');
  panel.hidden = true;
  const status = new FakeNode('p');
  const queue = new FakeNode('div');
  const elements = { ruModeration: panel, ruModerationStatus: status, ruModerationQueue: queue };
  return { document: { getElementById: id => elements[id], createElement: tag => new FakeNode(tag) }, panel, status, queue };
}

test('school moderators review same-school pending photos and publish only after photo approval', async () => {
  const f = fixture();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls = [];
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'council_member' } }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/listings/moderation' && calls.filter(call => call.url === url).length === 1) {
      return { ok: true, json: async () => ({ ok: true, listings: [{ id, title: '<script>unsafe</script>', description: 'Текст', category: 'Учёба', photo_status: 'pending', photo_url: `/api/v1/listings/${id}/photo` }] }) };
    }
    if (url === `/api/v1/listings/${id}/photo`) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ ok: true, listings: [] }) };
  } });
  assert.equal(f.panel.hidden, false);
  const card = f.queue.children[0];
  assert.equal(card.children[0].textContent, '<script>unsafe</script>');
  assert.equal(card.children[3].tagName, 'img');
  const actions = card.children.at(-1).children;
  assert.deepEqual(actions.map(button => button.textContent), ['Одобрить фото', 'Отклонить фото', 'Отклонить объявление']);
  await actions[0].listeners.click();
  const decision = calls.find(call => call.url === `/api/v1/listings/${id}/photo`);
  assert.equal(decision.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(decision.init.body), { decision: 'approve' });
  assert.equal(f.status.textContent, 'Очереди школьной проверки пусты.');
});

test('student profiles do not receive the school moderation queue', async () => {
  const f = fixture();
  const routes = [];
  await initializeListingModeration({ ...f, fetchImpl: async url => {
    routes.push(url);
    return { ok: true, json: async () => ({ ok: true, profile: { role: 'student' } }) };
  } });
  assert.deepEqual(routes, ['/api/v1/me']);
  assert.equal(f.panel.hidden, true);
});

test('staff can confirm or reject a pending event application using safe text rendering', async () => {
  const f = fixture();
  const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const calls = [];
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [{ event_id: eventId, event_title: '<b>Событие</b>', user_id: userId, status: 'pending', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' }] }) };
    if (url === '/api/v1/profile-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const card = f.queue.children[0];
  assert.equal(card.children[0].textContent, '<b>Событие</b>');
  assert.equal(card.children[1].textContent, 'Заявка: Аня Иванова · 8А');
  const actions = card.children[2].children;
  assert.deepEqual(actions.map(button => button.textContent), ['Подтвердить заявку', 'Отклонить заявку']);
  await actions[1].listeners.click();
  const decision = calls.find(call => call.url === `/api/v1/listings/${eventId}/registrations/${userId}`);
  assert.equal(decision.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(decision.init.body), { decision: 'reject' });
});

test('only school admins see profile access requests and approve them as students', async () => {
  const f = fixture();
  const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const calls = [];
  let pending = true;
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review') return { ok: true, json: async () => ({ ok: true, requests: pending ? [{ request_id: requestId, first_name: '<Аня>', last_name: 'Иванова', class_name: '8А' }] : [] }) };
    if (url === `/api/v1/profile-requests/${requestId}`) { pending = false; return { ok: true, json: async () => ({ ok: true, status: 'approved' }) }; }
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const card = f.queue.children[0];
  assert.equal(card.children[0].textContent, '<Аня> Иванова');
  const actions = card.children.at(-1).children;
  assert.deepEqual(actions.map(button => button.textContent), ['Одобрить ученика', 'Отклонить заявку']);
  await actions[0].listeners.click();
  const patch = calls.find(call => call.url === `/api/v1/profile-requests/${requestId}`);
  assert.equal(patch.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(patch.init.body), { decision: 'approve' });
});
