import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicBoard } from '../../web/public-board.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; }
  get childNodes() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
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
    if (url === '/api/v1/listings') options = { url, init };
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
    if (url === '/api/v1/favorites') return { ok: true, status: 200, json: async () => ({ ok: true, favorite_ids: [] }) };
    if (url === '/api/v1/me/listings') return { ok: false, status: 401, json: async () => ({}) };
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
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal(calls.at(-1).options.credentials, 'same-origin');
  assert.equal(register.textContent, 'Вы записаны');
  assert.equal(cancel.hidden, false);
  await cancel.listeners.click();
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(register.textContent, 'Записаться');
  assert.equal(cancel.hidden, true);
});

test('authenticated board users can toggle favorites through their own Russian API route', async () => {
  const root = new FakeNode('section');
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  await loadPublicBoard({ root, document: fakeDocument, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id, title: 'Учебник', description: 'Описание', category: 'Учёба', is_event: false },
    ] }) };
    if (url === '/api/v1/favorites') return { ok: true, json: async () => ({ ok: true, favorite_ids: [id] }) };
    return { ok: true, json: async () => ({ ok: true, favorited: options.method === 'PUT' }) };
  } });
  const card = root.children[0].children[0];
  const actions = card.children.find(node => node.className === 'ru-favorite-actions');
  const [toggle] = actions.children;
  assert.equal(toggle.textContent, 'Убрать из избранного');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  await toggle.listeners.click();
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(toggle.textContent, 'В избранное');
  await toggle.listeners.click();
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.equal(toggle.textContent, 'Убрать из избранного');
  assert.equal(calls.at(-1).options.credentials, 'same-origin');
});

test('guest favorite action sends the user to Yandex login without a write', async () => {
  const root = new FakeNode('section');
  const id = '11111111-1111-4111-8111-111111111111';
  let loginUrl;
  let writes = 0;
  await loadPublicBoard({ root, document: fakeDocument, location: { assign: value => { loginUrl = value; } }, fetchImpl: async url => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [{ id, title: 'Учебник', description: '', category: 'Учёба' }] }) };
    if (url === '/api/v1/favorites' || url === '/api/v1/me/listings') return { ok: false, status: 401, json: async () => ({}) };
    if (options?.method === 'PUT' || options?.method === 'DELETE') writes++;
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const card = root.children[0].children[0];
  const button = card.children.find(node => node.className === 'ru-favorite-actions').children[0];
  await button.listeners.click();
  assert.equal(loginUrl, '/auth/yandex/start');
  assert.equal(writes, 0);
});

test('only the authenticated owner sees the own-listing delete action, and confirmed deletion refreshes the card state', async () => {
  const root = new FakeNode('section');
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  let allowed = false;
  await loadPublicBoard({ root, document: fakeDocument, confirmImpl: () => allowed, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id, title: 'Моя книга', description: 'Описание', category: 'Учёба', price_text: 'Бесплатно' },
    ] }) };
    if (url === '/api/v1/favorites') return { ok: true, json: async () => ({ ok: true, favorite_ids: [] }) };
    if (url === '/api/v1/me/listings') return { ok: true, json: async () => ({ ok: true, listing_ids: [id] }) };
    if (url === `/api/v1/listings/${id}` && options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true, deleted: true, image_cleanup: 'not_needed' }) };
    throw new Error(`unexpected request ${url}`);
  } });
  const card = root.children[0].children[0];
  const actions = card.children.find(node => node.className === 'ru-own-listing-actions');
  assert.ok(actions);
  const button = actions.children[0];
  await button.listeners.click();
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false, 'cancelled confirmation does not write');
  allowed = true;
  await button.listeners.click();
  const deletion = calls.find(call => call.options.method === 'DELETE');
  assert.equal(deletion.url, `/api/v1/listings/${id}`);
  assert.equal(deletion.options.credentials, 'same-origin');
  assert.equal(card.hidden, true);
  assert.equal(actions.children[1].textContent, 'Объявление удалено.');
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
