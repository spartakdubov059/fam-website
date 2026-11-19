import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeProfileSettings } from '../../web/profile-settings.js';

class Element {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.attributes = {}; this.textContent = ''; this.hidden = false; }
  append(...items) { this.children.push(...items); }
  setAttribute(name, value) { this.attributes[name] = value; }
  before(item) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, item); item.parentElement = this.parentElement; }
}

function fixture() {
  const shell = new Element('main');
  const listingForm = new Element('form'); listingForm.id = 'ruListingForm'; listingForm.parentElement = shell; shell.append(listingForm);
  const document = { getElementById: id => id === 'ruListingForm' ? listingForm : null,
    createElement: tag => new Element(tag) };
  return { document, shell, listingForm };
}

test('profile network failure shows that account data were not deleted', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => { throw new Error('offline'); } });
  const section = f.shell.children[0];
  assert.equal(section.id, 'ruProfileSettings');
  assert.match(section.children[1].textContent, /не считаются удалёнными/);
  assert.equal(section.children[1].attributes['aria-live'], 'polite');
});

test('unauthenticated profile request stays quiet and exposes no account controls', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({ ok: false }) }) });
  assert.deepEqual(f.shell.children, [f.listingForm]);
});

test('unavailable profile response does not expose profile editing controls', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({ ok: false }) }) });
  const section = f.shell.children[0];
  assert.equal(section.id, 'ruProfileSettings');
  assert.equal(section.children.length, 2);
  assert.match(section.children[0].textContent, /временно недоступен/);
});
