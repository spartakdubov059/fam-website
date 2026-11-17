import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeProfileSettings } from '../../web/profile-settings.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  before(node) { this.parentElement.children.push(node); }
}

function fixture() {
  const shell = new FakeNode('main');
  const listingForm = new FakeNode('form'); listingForm.id = 'ruListingForm'; listingForm.parentElement = shell; shell.children.push(listingForm);
  const values = { ruListingForm: listingForm };
  return { document: { getElementById: id => values[id] || null, createElement: tag => new FakeNode(tag) }, shell };
}

test('Russian profile settings update only the authenticated profile through the YDB API', async () => {
  const { document, shell } = fixture();
  const calls = [];
  await initializeProfileSettings({ document, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'PATCH') return { ok: true, status: 200, json: async () => ({ ok: true, profile: { first_name: 'Анна' } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, profile: {
      id: '11111111-1111-4111-8111-111111111111', first_name: 'Анна', last_name: 'Иванова',
      person_type: 'student', class_name: '8А', staff_position: '',
    } }) };
  } });

  const section = shell.children.find(node => node.id === 'ruProfileSettings');
  const form = section.children.find(node => node.id === 'ruProfileSettingsForm');
  const [first, last, person, schoolClass, staffPosition] = form.children;
  assert.equal(first.children[0].value, 'Анна');
  assert.equal(schoolClass.hidden, false);
  assert.equal(staffPosition.hidden, true);
  first.children[0].value = 'Мария';
  person.children[0].value = 'parent';
  await person.children[0].listeners.change();
  assert.equal(schoolClass.hidden, true);
  assert.equal(staffPosition.hidden, true);
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/me', '/api/v1/me']);
  assert.equal(calls[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    first_name: 'Мария', last_name: 'Иванова', person_type: 'parent', class_name: '', staff_position: '',
  });
  assert.equal('user_id' in JSON.parse(calls[1].options.body), false);
  assert.equal(form.children[5].textContent, 'Профиль сохранён.');
});

test('Russian profile settings are not shown to guests or profiles not yet linked to a school', async () => {
  const guest = fixture();
  await initializeProfileSettings({ document: guest.document, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(guest.shell.children.length, 1);

  const unlinked = fixture();
  await initializeProfileSettings({ document: unlinked.document, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'profile_unavailable' }) }) });
  assert.equal(unlinked.shell.children.length, 1);
});
