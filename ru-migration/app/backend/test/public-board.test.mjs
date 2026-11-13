import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicBoard } from '../../web/public-board.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; }
  get childNodes() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
const fakeDocument = {
  createElement: tag => new FakeNode(tag),
  createDocumentFragment: () => new FakeNode('#fragment'),
};

test('guest board requests only the public endpoint and writes listing data as text', async () => {
  const root = new FakeNode('section');
  let options;
  await loadPublicBoard({ root, document: fakeDocument, fetchImpl: async (url, init) => {
    options = { url, init };
    return { ok: true, json: async () => ({ ok: true, listings: [{ id: 'listing-1', title: '<script>alert(1)</script>', description: 'Синтетическое описание', category: 'Учёба', price_text: 'Бесплатно', is_event: false }] }) };
  } });
  assert.equal(options.url, '/api/v1/listings');
  assert.equal(options.init.credentials, 'omit');
  assert.equal(options.init.cache, 'no-store');
  const title = root.children[0].children[0].children[1];
  assert.equal(title.textContent, '<script>alert(1)</script>');
  assert.equal(title.children.length, 0, 'untrusted listing title is never parsed as markup');
});

test('guest board renders a useful empty state when there are no approved listings', async () => {
  const root = new FakeNode('section');
  await loadPublicBoard({ root, document: fakeDocument, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, listings: [] }) }) });
  assert.match(root.children[0].textContent, /Пока нет опубликованных объявлений/);
});

test('guest board offers retry when the Russian API is unavailable', async () => {
  const root = new FakeNode('section');
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('offline'); };
  await loadPublicBoard({ root, document: fakeDocument, fetchImpl });
  assert.equal(root.children[0].attributes.role, 'status');
  assert.equal(root.children[1].textContent, 'Повторить');
  await root.children[1].listeners.click();
  assert.equal(calls, 2);
});

test('event card reads only the user own registrations and supports reservation and cancellation', async () => {
  const root = new FakeNode('section');
  const calls = [];
  const eventId = '11111111-1111-4111-8111-111111111111';
  await loadPublicBoard({ root, document: fakeDocument, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: eventId, title: 'Синтетический концерт', description: 'Проверка записи', category: 'Афиша', price_text: 'Бесплатно', is_event: true, event_type: 'limited', max_seats: 12, event_date: '2099-05-01', event_time: '12:00' },
    ] }) };
    if (url === '/api/v1/event-registrations') return { ok: true, status: 200, json: async () => ({ ok: true, registrations: [] }) };
    if (url === `/api/v1/listings/${eventId}/registrations`) return { ok: true, status: 201, json: async () => ({ ok: true, registration: { event_id: eventId, user_id: 'synthetic-user', status: 'confirmed' } }) };
    if (url === `/api/v1/listings/${eventId}/registrations/me`) return { ok: true, status: 200, json: async () => ({ ok: true, status: 'cancelled' }) };
    throw new Error(`unexpected request ${url}`);
  } });
  const card = root.children[0].children[0];
  const actions = card.children.find(node => node.className === 'ru-event-actions');
  const [register, cancel] = actions.children;
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(register.textContent, 'Записаться');
  assert.equal(cancel.hidden, true);
  await register.listeners.click();
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.body, undefined);
  assert.equal(calls[2].options.credentials, 'same-origin');
  assert.equal(register.textContent, 'Вы записаны');
  assert.equal(cancel.hidden, false);
  await cancel.listeners.click();
  assert.equal(calls[3].options.method, 'DELETE');
  assert.equal(register.textContent, 'Записаться');
  assert.equal(cancel.hidden, true);
});

test('guest event action redirects to Yandex login and unavailable event APIs disable registration', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const makeRoot = () => new FakeNode('section');
  const root = makeRoot();
  let loginUrl;
  await loadPublicBoard({ root, document: fakeDocument, location: { assign: value => { loginUrl = value; } }, fetchImpl: async url => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [{ id: eventId, title: 'Событие', description: '', category: 'Афиша', is_event: true }] }) };
    return { ok: false, status: 401, json: async () => ({}) };
  } });
  const actions = root.children[0].children[0].children.find(node => node.className === 'ru-event-actions');
  await actions.children[0].listeners.click();
  assert.equal(loginUrl, '/auth/yandex/start');

  const unavailableRoot = makeRoot();
  await loadPublicBoard({ root: unavailableRoot, document: fakeDocument, fetchImpl: async url =>
    url === '/api/v1/listings'
      ? { ok: true, json: async () => ({ ok: true, listings: [{ id: eventId, title: 'Событие', description: '', category: 'Афиша', is_event: true }] }) }
      : { ok: false, status: 503, json: async () => ({}) },
  });
  const unavailableActions = unavailableRoot.children[0].children[0].children.find(node => node.className === 'ru-event-actions');
  assert.equal(unavailableActions.children[0].disabled, true);
  assert.equal(unavailableActions.children[0].textContent, 'Запись недоступна');
});
