import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeOwnListings } from '../../web/own-listings.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.hidden = true; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  remove() { this.removed = true; }
}

test('own listing history renders statuses as text and never displays private storage fields', async () => {
  const section = new Element('section');
  const document = { getElementById: id => id === 'ruOwnListings' ? section : null, createElement: tag => new Element(tag) };
  await initializeOwnListings({ document, fetchImpl: async (url, options) => {
    assert.equal(url, '/api/v1/me/listings');
    assert.equal(options.credentials, 'same-origin');
    return { ok: true, status: 200, json: async () => ({ ok: true, listings: [{
      id: 'listing-id', title: '<script>Тест</script>', description: 'Описание', status: 'pending', photo_status: 'pending',
      category: 'Учёба', price_text: 'Бесплатно', image_key: 'private/object/key', school_id: 'private-school',
    }] }) };
  } });
  assert.equal(section.hidden, false);
  const allText = JSON.stringify(section.children, (key, value) => key === 'parentElement' ? undefined : value);
  assert.match(allText, /На проверке/);
  assert.match(allText, /Фото ожидает проверки/);
  assert.match(allText, /<script>Тест<\/script>/);
  assert.doesNotMatch(allText, /private\/object\/key|private-school/);
});
