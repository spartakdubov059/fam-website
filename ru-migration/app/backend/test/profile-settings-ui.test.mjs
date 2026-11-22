import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeProfileSettings } from '../../web/profile-settings.js';

class Element {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.attributes = {}; this.textContent = ''; this.hidden = false; this.listeners = {}; this.value = ''; }
  append(...items) { this.children.push(...items); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  async dispatch(name, event = {}) { return Promise.all((this.listeners[name] || []).map(handler => handler({ ...event, type: name }))); }
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

test('profile directs email management to Yandex ID without storing the provider email in FAM', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true,
    profile: { id: 'student-user', first_name: 'Аня', person_type: 'student' } }) }) });
  const section = f.shell.children[0];
  assert.match(section.children[2].textContent, /использует адрес из Яндекс ID.*не сохраняет его в школьном профиле/);
  const link = section.children.find(item => item.tagName === 'a');
  assert.equal(link.href, 'https://id.yandex.ru/');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
});

test('unavailable profile response does not expose profile editing controls', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({ ok: false }) }) });
  const section = f.shell.children[0];
  assert.equal(section.id, 'ruProfileSettings');
  assert.equal(section.children.length, 2);
  assert.match(section.children[0].textContent, /временно недоступен/);
});

test('school staff can see pending verification state and its refreshed API value', async () => {
  class InteractiveElement extends Element {
    constructor(tagName = 'div') { super(tagName); this.listeners = {}; this.value = ''; }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    async dispatch(name, event = {}) { return Promise.all((this.listeners[name] || []).map(handler => handler({ ...event, type: name }))); }
  }
  const shell = new InteractiveElement('main');
  const listingForm = new InteractiveElement('form'); listingForm.id = 'ruListingForm'; listingForm.parentElement = shell; shell.append(listingForm);
  const document = { getElementById: id => id === 'ruListingForm' ? listingForm : null, createElement: tag => new InteractiveElement(tag) };
  const calls = [];
  await initializeProfileSettings({ document, fetchImpl: async (_url, init = {}) => {
    calls.push(init);
    return init.method === 'PATCH'
      ? { ok: true, json: async () => ({ ok: true, profile: { person_type: 'school_staff', staff_position: 'Учитель математики', staff_verification_status: 'pending' } }) }
      : { ok: true, json: async () => ({ ok: true, profile: { id: 'staff-user', first_name: 'Мария', last_name: 'Соколова', person_type: 'school_staff', staff_position: 'Учитель математики', staff_verification_status: 'pending' } }) };
  } });
  const section = shell.children[0];
  const form = section.children.find(item => item.tagName === 'form');
  const person = form.children[2].children[0];
  const position = form.children[4].children[0];
  const verification = form.children[5];
  assert.equal(verification.hidden, false);
  assert.match(verification.textContent, /ожидает проверки/);
  person.value = 'student'; person.dispatch('change');
  assert.equal(verification.hidden, true);
  person.value = 'school_staff'; person.dispatch('change');
  position.value = 'Учитель математики';
  await form.dispatch('submit', { preventDefault() {} });
  assert.equal(calls[1].method, 'PATCH');
  assert.match(verification.textContent, /ожидает проверки/);
});

test('a rejected staff position is explained and remains editable', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true,
    profile: { id: 'staff-user', person_type: 'school_staff', staff_position: 'Учитель', staff_verification_status: 'rejected' } }) }) });
  const section = f.shell.children[0];
  const form = section.children.find(item => item.tagName === 'form');
  assert.match(form.children[5].textContent, /Исправьте её и сохраните/);
  assert.equal(form.children[4].hidden, false);
});

test('an approved school staff position is visibly confirmed', async () => {
  const f = fixture();
  await initializeProfileSettings({ ...f, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true,
    profile: { id: 'staff-user', person_type: 'school_staff', staff_position: 'Директор', staff_verification_status: 'approved' } }) }) });
  const section = f.shell.children[0];
  const form = section.children.find(item => item.tagName === 'form');
  assert.match(form.children[5].textContent, /подтверждена администратором школы/);
  assert.equal(form.children[5].hidden, false);
});
