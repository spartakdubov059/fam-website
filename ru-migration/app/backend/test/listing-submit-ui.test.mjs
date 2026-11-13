import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeListingSubmission } from '../../web/listing-submit.js';

function fixture(file = { type: 'image/png', size: 100, name: 'synthetic.png' }) {
  const listeners = {};
  const form = { hidden: true, elements: { photo: { files: file ? [file] : [] } },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    querySelector: () => ({ disabled: false }), reset: () => { form.wasReset = true; } };
  const status = { textContent: '' };
  const login = { hidden: false };
  const logout = { hidden: true, addEventListener: (name, fn) => { logout.handler = fn; } };
  const document = { getElementById: id => ({ ruListingForm: form, ruSubmitStatus: status, ruLogout: logout })[id],
    querySelector: () => login };
  class FormDataMock { get(name) { return ({ title: 'Книга', description: 'Синтетическое описание', category: 'Учёба', price_text: '' })[name]; } }
  return { document, form, status, login, logout, listeners, FormDataCtor: FormDataMock };
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
