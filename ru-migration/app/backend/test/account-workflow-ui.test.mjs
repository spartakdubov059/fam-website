import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAccountWorkflow } from '../../web/account-workflow.js';

class Element {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.listeners = {}; this.hidden = true; this.textContent = ''; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
}

function fixture() {
  const elements = { ruAccountWorkflow: new Element('section') };
  return { elements, document: { getElementById: id => elements[id], createElement: tag => new Element(tag) } };
}

test('RU account deletion rejects an inexact confirmation without sending a delete request', async () => {
  const f = fixture(); const calls = [];
  f.document.defaultView = { confirm: () => true, prompt: () => 'удалить' };
  await initializeAccountWorkflow({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: '11111111-1111-4111-8111-111111111111' } }) };
    throw new Error(`unexpected route ${url}`);
  } });
  const button = f.elements.ruAccountWorkflow.children[3];
  await button.listeners.click();
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/me']);
  assert.match(f.elements.ruAccountWorkflow.children[2].textContent, /не совпала/);
});

test('RU account deletion sends the exact confirmation, then logs out and refreshes', async () => {
  const f = fixture(); const calls = []; let reloaded = false;
  f.document.defaultView = { confirm: () => true, prompt: () => 'УДАЛИТЬ МОЙ АККАУНТ' };
  const location = { reload() { reloaded = true; } };
  await initializeAccountWorkflow({ ...f, location, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: '11111111-1111-4111-8111-111111111111' } }) };
    if (url === '/api/v1/me/account') return { ok: true, json: async () => ({ ok: true, deleted: true, removed_images: 1 }) };
    if (url === '/auth/yandex/logout') return { ok: true, json: async () => ({ ok: true }) };
    throw new Error(`unexpected route ${url}`);
  } });
  await f.elements.ruAccountWorkflow.children[3].listeners.click();
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/me', '/api/v1/me/account', '/auth/yandex/logout']);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].init.body), { confirmation: 'УДАЛИТЬ МОЙ АККАУНТ' });
  assert.equal(reloaded, true);
  assert.equal(f.elements.ruAccountWorkflow.children[0].textContent, 'Аккаунт удалён');
});
