import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeNotifications } from '../../web/notifications.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.hidden = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function fixture() {
  const values = Object.fromEntries(['ruOpenNotifications', 'ruNotifications', 'ruNotificationStatus', 'ruNotificationList', 'ruNotificationBadge', 'ruNotificationRefresh']
    .map(id => [id, new FakeNode(id)]));
  values.ruNotifications.hidden = true;
  values.ruNotificationBadge.hidden = true;
  return { document: { getElementById: id => values[id] || null, createElement: tag => new FakeNode(tag) }, values };
}

test('Russian fallback notification center combines the signed-in inbox and release notices, then persists read state', async () => {
  const { document, values } = fixture();
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const peerId = '22222222-2222-4222-8222-222222222222';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  let savedKeys = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/me') return { status: 200, ok: true, json: async () => ({ ok: true, profile: { id: ownerId, school_id: 'school-a', role: 'student' } }) };
    if (url === '/api/v1/messages') return { status: 200, ok: true, json: async () => ({ ok: true, messages: [
      { id: messageId, sender_id: peerId, receiver_id: ownerId, body: '<unsafe>', is_read: false, created_at: '2026-01-01T00:00:00Z' },
      { id: '44444444-4444-4444-8444-444444444444', sender_id: ownerId, receiver_id: peerId, body: 'Чужое', is_read: false },
    ] }) };
    if (url === '/api/v1/listings') return { status: 200, ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/role-requests') return { status: 200, ok: true, json: async () => ({ ok: true, request: null }) };
    if (url === '/api/v1/notification-reads' && options.method === 'POST') {
      savedKeys.push(...JSON.parse(options.body).notification_keys);
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (url === '/api/v1/notification-reads') return { status: 200, ok: true, json: async () => ({ ok: true, notification_keys: [] }) };
    if (url === '/api/v1/messages/read' && options.method === 'POST') return { status: 200, ok: true, json: async () => ({ ok: true, updated: 1 }) };
    throw new Error(`unexpected request ${url}`);
  };
  await initializeNotifications({ document, fetchImpl });
  assert.equal(values.ruNotificationBadge.hidden, false);
  assert.equal(values.ruNotificationBadge.textContent, '3');
  assert.equal(values.ruNotifications.hidden, true);
  await values.ruOpenNotifications.listeners.click();
  assert.equal(values.ruNotificationList.children.length, 3);
  const messageItem = values.ruNotificationList.children.find(item => item.children[1]?.textContent === '<unsafe>');
  assert.ok(messageItem);
  assert.equal(messageItem.children[1].tagName, 'p');
  assert.deepEqual(JSON.parse(calls.find(call => call.url === '/api/v1/messages/read')?.options.body).message_ids, [messageId]);
  assert.ok(savedKeys.includes(`message:${messageId}`));
  assert.ok(savedKeys.some(key => key.startsWith('release:')));
});

test('Russian fallback notification center prompts guests to sign in', async () => {
  const { document, values } = fixture();
  await initializeNotifications({ document, fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }) });
  assert.equal(values.ruNotificationBadge.hidden, true);
  assert.match(values.ruNotificationStatus.textContent, /Войдите через Яндекс ID/);
});
