import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeOwnListings } from '../../web/own-listings.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.hidden = true; this.disabled = false; this.listeners = {}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  remove() { this.removed = true; }
}

function firstCard(section) {
  const grid = section.children.find(child => child.className === 'ru-own-listings-grid');
  return grid?.children[0];
}

test('own listing history renders statuses as text and never displays private storage fields', async () => {
  const section = new Element('section');
  let request;
  const document = { getElementById: id => id === 'ruOwnListings' ? section : null, createElement: tag => new Element(tag) };
  await initializeOwnListings({ document, confirmImpl: () => true, fetchImpl: async (url, options) => {
    request = { url, options };
    if (url !== '/api/v1/me/listings') return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true, image_cleanup: 'queued' }) };
    assert.equal(options.credentials, 'same-origin');
    return { ok: true, status: 200, json: async () => ({ ok: true, listings: [{
      id: '11111111-1111-4111-8111-111111111111', title: '<script>Тест</script>', description: 'Описание', status: 'pending', photo_status: 'pending',
      category: 'Учёба', price_text: 'Бесплатно', image_key: 'private/object/key', school_id: 'private-school',
    }] }) };
  } });
  assert.equal(section.hidden, false);
  const allText = JSON.stringify(section.children, (key, value) => key === 'parentElement' ? undefined : value);
  assert.match(allText, /На проверке/);
  assert.match(allText, /Фото ожидает проверки/);
  assert.match(allText, /<script>Тест<\/script>/);
  assert.doesNotMatch(allText, /private\/object\/key|private-school/);
  const card = firstCard(section);
  const actions = card.children.at(-1);
  assert.equal(actions.children[0].textContent, 'Удалить своё объявление');
  await actions.children[0].listeners.click();
  assert.equal(request.url, '/api/v1/listings/11111111-1111-4111-8111-111111111111');
  assert.equal(request.options.method, 'DELETE');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(actions.children[0].textContent, 'Удалено');
  assert.match(actions.children[1].textContent, /фото будет очищено позже/);
});

test('own listing history does not create delete links from malformed server ids', async () => {
  const section = new Element('section');
  const document = { getElementById: id => id === 'ruOwnListings' ? section : null, createElement: tag => new Element(tag) };
  await initializeOwnListings({ document, fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ ok: true, listings: [{ id: '../../api/v1/me/account', title: 'Synthetic', status: 'pending' }] }) }) });
  const card = firstCard(section);
  assert.equal(card.children.some(child => child.className === 'ru-own-listing-actions'), false);
});
