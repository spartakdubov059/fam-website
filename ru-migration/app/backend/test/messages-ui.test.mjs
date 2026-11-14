import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeMessages } from '../../web/messages.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.textContent = ''; this.value = ''; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) { return selector === 'button[type="submit"]' ? this.submitButton : null; }
}

function fixture() {
  const values = Object.fromEntries(['ruOpenMessages', 'ruMessages', 'ruMessagesStatus', 'ruMessageList', 'ruMessageForm', 'ruMessagesBack']
    .map(id => [id, new FakeNode(id)]));
  values.ruMessages.hidden = true;
  values.ruMessageForm.hidden = true;
  values.ruMessagesBack.hidden = true;
  values.ruMessageForm.elements = { namedItem: name => name === 'body' ? (values.body ??= new FakeNode('input')) : null };
  values.ruMessageForm.submitButton = new FakeNode('button');
  return { document: { getElementById: id => values[id] || null, createElement: tag => new FakeNode(tag) }, values };
}

test('Russian fallback opens the authenticated inbox and marks only the recipient message read', async () => {
  const { document, values } = fixture();
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const peerId = '22222222-2222-4222-8222-222222222222';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  await initializeMessages({ document, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/me') return { status: 200, ok: true, json: async () => ({ ok: true, profile: { id: ownerId } }) };
    if (url === '/api/v1/messages') return { status: 200, ok: true, json: async () => ({ ok: true, messages: [
      { id: messageId, sender_id: peerId, receiver_id: ownerId, body: 'Проверка диалога', is_read: false, created_at: '2026-01-01T00:00:00Z' },
    ] }) };
    if (url === `/api/v1/messages/${messageId}/read`) return { status: 200, ok: true, json: async () => ({ ok: true }) };
    throw new Error(`unexpected request ${url}`);
  } });

  assert.equal(values.ruMessages.hidden, true, 'inbox remains closed until the user opens it');
  await values.ruOpenMessages.listeners.click();
  assert.equal(values.ruMessages.hidden, false);
  assert.equal(values.ruOpenMessages.attributes['aria-expanded'], 'true');
  assert.equal(values.ruMessageList.children[0].textContent, 'Диалог · Проверка диалога · новое');
  await values.ruMessageList.children[0].listeners.click();
  assert.equal(values.ruMessagesBack.hidden, false);
  assert.equal(values.ruMessageList.children[0].textContent, 'Проверка диалога');
  assert.equal(values.ruMessageForm.hidden, false);
  assert.equal(calls[0].url, '/api/v1/me');
  assert.equal(calls[1].url, '/api/v1/messages');
  assert.equal(calls.some(call => call.url === `/api/v1/messages/${messageId}/read`), true);
});

test('Russian fallback offers Yandex sign-in for a guest who opens messages', async () => {
  const { document, values } = fixture();
  await initializeMessages({ document, location: { assign() {} }, fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }) });
  await values.ruOpenMessages.listeners.click();
  assert.equal(values.ruMessagesStatus.textContent, 'Войдите через Яндекс ID, чтобы читать сообщения.');
  assert.equal(values.ruMessageList.children[0].href, '/auth/yandex/start');
  assert.equal(values.ruMessageList.children[0].textContent, 'Войти через Яндекс ID');
});

test('message awaiting school review is not presented as delivered to its recipient', async () => {
  const { document, values } = fixture();
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const peerId = '22222222-2222-4222-8222-222222222222';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  await initializeMessages({ document, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/me') return { status: 200, ok: true, json: async () => ({ ok: true, profile: { id: ownerId } }) };
    if (url === '/api/v1/messages' && options.method === 'POST') return { status: 201, ok: true, json: async () => ({ ok: true, status: 'pending', id: 'pending-id' }) };
    if (url === '/api/v1/messages') return { status: 200, ok: true, json: async () => ({ ok: true, messages: [
      { id: messageId, sender_id: ownerId, receiver_id: peerId, body: 'Старый диалог', is_read: true, created_at: '2026-01-01T00:00:00Z' },
    ] }) };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  } });
  await values.ruOpenMessages.listeners.click();
  await values.ruMessageList.children[0].listeners.click();
  values.ruMessageForm.elements.namedItem('body').value = 'Новое сообщение для проверки';
  await values.ruMessageForm.listeners.submit({ preventDefault() {} });
  const sent = calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(sent.options.body), { receiver_id: peerId, body: 'Новое сообщение для проверки' });
  assert.match(values.ruMessagesStatus.textContent, /передано администратору школы на проверку/);
  assert.match(values.ruMessagesStatus.textContent, /Получатель увидит его после одобрения/);
});
