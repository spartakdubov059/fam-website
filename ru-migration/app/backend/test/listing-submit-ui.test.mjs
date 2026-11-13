import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeListingSubmission } from '../../web/listing-submit.js';

function fixture(file = { type: 'image/png', size: 100, name: 'synthetic.png' }) {
  const shellChildren = [];
  const listeners = {};
  const form = { hidden: true, elements: { photo: { files: file ? [file] : [] } },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    querySelector: () => ({ disabled: false }), reset: () => { form.wasReset = true; }, parentElement: { append: child => shellChildren.push(child) } };
  const status = { textContent: '' };
  const login = { hidden: false };
  const logout = { hidden: true, addEventListener: (name, fn) => { logout.handler = fn; } };
  const document = { getElementById: id => ({ ruListingForm: form, ruSubmitStatus: status, ruLogout: logout })[id],
    querySelector: () => login,
    createElement: tag => ({ tagName: tag, children: [], listeners: {}, append(...nodes) { this.children.push(...nodes); },
      addEventListener(name, handler) { this.listeners[name] = handler; }, setAttribute(name, value) { this[name] = value; },
      querySelector(selector) { return selector.includes('button') ? { disabled: false } : this.children.find(child => child.role === 'status'); },
      reset() { this.wasReset = true; } }) };
  class FormDataMock { get(name) { return ({ title: 'Книга', description: 'Синтетическое описание', category: 'Учёба', price_text: '' })[name]; } }
  return { document, form, status, login, logout, listeners, shellChildren, FormDataCtor: FormDataMock };
}

test('listing form authenticates first, then uploads a private photo and submits its key to the Russian API', async () => {
  const f = fixture();
  const calls = [];
  await initializeListingSubmission({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'synthetic-user' } }) };
    if (url === '/api/v1/media/pending') return { ok: true, json: async () => ({ ok: true, image: { key: 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp' } }) };
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, status: 'pending' }) };
    throw new Error(`unexpected route ${url}`);
  } });
  assert.equal(f.form.hidden, false);
  assert.equal(f.login.hidden, true);
  assert.equal(f.logout.hidden, false);
  let prevented = false;
  await f.listeners.submit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/me', '/api/v1/media/pending', '/api/v1/listings']);
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.equal(calls[1].init.headers['content-type'], 'image/png');
  assert.equal(JSON.parse(calls[2].init.body).image_key, 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp');
  assert.equal(JSON.parse(calls[2].init.body).price_text, 'Бесплатно');
  assert.equal(f.form.wasReset, true);
  assert.match(f.status.textContent, /отправлено/);
});

test('listing form removes an unlinked upload after a failed listing write', async () => {
  const f = fixture();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls = [];
  await initializeListingSubmission({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'synthetic-user' } }) };
    if (url === '/api/v1/media/pending') return { ok: true, json: async () => ({ ok: true, image: { key: `pending/11111111-1111-4111-8111-111111111111/${id}.webp` } }) };
    if (url === '/api/v1/listings') return { ok: false, json: async () => ({ ok: false }) };
    if (url === `/api/v1/media/pending/${id}`) return { ok: true, json: async () => ({ ok: true }) };
    throw new Error(`unexpected route ${url}`);
  } });
  await f.listeners.submit({ preventDefault() {} });
  assert.equal(calls.at(-1).url, `/api/v1/media/pending/${id}`);
  assert.equal(calls.at(-1).init.method, 'DELETE');
  assert.match(f.status.textContent, /удалено/);
});

test('listing form does not make authenticated calls for a guest and validates image size/type locally', async () => {
  const guest = fixture();
  let requests = 0;
  await initializeListingSubmission({ ...guest, fetchImpl: async () => { requests++; return { ok: false, status: 401 }; } });
  assert.equal(guest.form.hidden, true);
  assert.equal(requests, 1);

  const invalid = fixture({ type: 'image/svg+xml', size: 10 });
  const routes = [];
  await initializeListingSubmission({ ...invalid, fetchImpl: async url => {
    routes.push(url);
    return { ok: true, json: async () => ({ ok: true, profile: { id: 'synthetic-user' } }) };
  } });
  await invalid.listeners.submit({ preventDefault() {} });
  assert.deepEqual(routes, ['/api/v1/me']);
  assert.match(invalid.status.textContent, /JPEG, PNG или WebP/);
});

test('authenticated students can submit a school idea through the moderated Russian API', async () => {
  const f = fixture(null);
  const calls = [];
  await initializeListingSubmission({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'student-a' } }) };
    if (url === '/api/v1/ideas') return { ok: true, json: async () => ({ ok: true, status: 'pending' }) };
    throw new Error(`unexpected route ${url}`);
  } });
  const section = f.shellChildren[0];
  const ideaForm = section.children[2];
  ideaForm.elements = { idea: { value: 'Открыть школьный книжный обмен' } };
  let prevented = false;
  await ideaForm.listeners.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/me', '/api/v1/ideas']);
  assert.equal(JSON.parse(calls[1].init.body).text, 'Открыть школьный книжный обмен');
  assert.equal(ideaForm.wasReset, true);
  assert.match(ideaForm.children[1].textContent, /ждёт проверки безопасности/);
});

test('student role request UI refreshes status and never sends a browser-selected school or identity', async () => {
  const f = fixture(null); const calls = []; let submitted = false;
  await initializeListingSubmission({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'student-id', role: 'student' } }) };
    if (url === '/api/v1/role-requests' && init.method === 'POST') { submitted = true; return { ok: true, status: 202, json: async () => ({ ok: true, status: 'pending' }) }; }
    if (url === '/api/v1/role-requests') return { ok: true, json: async () => ({ ok: true, request: submitted ? { status: 'pending' } : null }) };
    if (url === '/api/v1/ideas') return { ok: true, json: async () => ({ ok: true }) };
    throw new Error(`unexpected route ${url}`);
  } });
  const section = f.shellChildren.find(item => item['aria-label'] === 'Заявка на роль школьного Совета');
  assert.ok(section);
  const form = section.children[2];
  const select = form.children[0].children[0]; select.value = 'Участник Ученического совета';
  await form.listeners.submit({ preventDefault() {} });
  const submittedCall = calls.find(call => call.url === '/api/v1/role-requests' && call.init.method === 'POST');
  assert.deepEqual(JSON.parse(submittedCall.init.body), { requested_role: 'Участник Ученического совета' });
  assert.equal(form.hidden, true);
  assert.match(section.children[1].textContent, /ожидает решения/);
});

test('authenticated unprovisioned Yandex users can request a school profile without receiving a role', async () => {
  const f = fixture(null);
  const calls = [];
  await initializeListingSubmission({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: false, status: 403, json: async () => ({ ok: false, error: 'profile_unavailable' }) };
    if (url === '/api/v1/profile-requests' && init.method === 'GET') return { ok: true, json: async () => ({ ok: true, request: null }) };
    if (url === '/api/v1/schools') return { ok: true, json: async () => ({ ok: true, schools: [{ id: 'lyceum_3', name: 'Лицей № 3' }] }) };
    if (url === '/api/v1/profile-requests') return { ok: true, status: 202, json: async () => ({ ok: true, status: 'pending' }) };
    throw new Error(`unexpected route ${url}`);
  } });
  assert.equal(f.login.hidden, true);
  assert.equal(f.logout.hidden, false);
  const form = f.shellChildren[0].children[2];
  form.elements = { school_id: { value: 'lyceum_3' }, first_name: { value: 'Аня' }, last_name: { value: 'Иванова' }, class_name: { value: '8А' } };
  await form.listeners.submit({ preventDefault() {} });
  const request = calls.find(call => call.url === '/api/v1/profile-requests' && call.init.method === 'POST');
  assert.deepEqual(JSON.parse(request.init.body), { school_id: 'lyceum_3', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' });
  assert.equal(request.init.credentials, 'same-origin');
  assert.match(f.status.textContent, /после одобрения/);
});

test('returning applicant sees private request status and can refresh it without resubmitting PII', async () => {
  const f = fixture(null);
  let reads = 0;
  await initializeListingSubmission({ ...f, fetchImpl: async url => {
    if (url === '/api/v1/me') return { ok: false, status: 403, json: async () => ({ ok: false, error: 'profile_unavailable' }) };
    if (url === '/api/v1/profile-requests') {
      reads++;
      return { ok: true, json: async () => ({ ok: true, request: { status: 'pending', school_id: 'lyceum_3' } }) };
    }
    throw new Error(`unexpected route ${url}`);
  } });
  const section = f.shellChildren[0];
  assert.match(section.children[1].textContent, /уже отправлена/);
  assert.equal(section.children[2].textContent, 'Проверить статус');
  await section.children[2].listeners.click();
  assert.equal(reads, 2);
  assert.match(section.children[1].textContent, /всё ещё ожидает/);
  assert.equal(f.document.getElementById('ruProfileRequestForm'), undefined);
});
