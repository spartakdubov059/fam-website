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
