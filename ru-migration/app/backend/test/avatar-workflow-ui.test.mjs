import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAvatarWorkflow } from '../../web/avatar-workflow.js';

class Element {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.listeners = {}; this.hidden = false; this.textContent = ''; this.dataset = {}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  reset() { this.wasReset = true; }
}

function fixture() {
  const elements = {
    ruAvatarWorkflow: new Element('section'),
    ruAvatarReviewQueue: new Element('div'),
    ruModeration: new Element('section'),
  };
  elements.ruAvatarWorkflow.hidden = true;
  elements.ruModeration.hidden = true;
  return { elements, document: { getElementById: id => elements[id], createElement: tag => new Element(tag) } };
}

const student = { id: '11111111-1111-4111-8111-111111111111', role: 'student' };
const staff = { id: '22222222-2222-4222-8222-222222222222', role: 'school_admin' };
const photoUrl = '/api/v1/avatars/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/photo';

test('RU avatar form uploads privately and submits the Russian review route', async () => {
  const f = fixture(); const calls = [];
  const file = { type: 'image/png', size: 42, name: 'synthetic.png' };
  await initializeAvatarWorkflow({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: student }) };
    if (url === '/api/v1/avatars/media/pending') return { ok: true, json: async () => ({ ok: true, image: { key: 'pending/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp' } }) };
    if (url === '/api/v1/me/avatar') return { ok: true, json: async () => ({ ok: true, status: 'pending' }) };
    throw new Error(`unexpected route ${url}`);
  } });
  const section = f.elements.ruAvatarWorkflow;
  assert.equal(section.hidden, false);
  const form = section.children.find(item => item.tagName === 'form');
  const input = form.children[0].children[0]; input.files = [file];
  let prevented = false;
  await form.listeners.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/me', '/api/v1/avatars/media/pending', '/api/v1/me/avatar']);
  assert.equal(calls[1].init.body, file);
  assert.deepEqual(JSON.parse(calls[2].init.body), { image_key: 'pending/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp' });
  assert.match(section.children[1].textContent, /отправлено модераторам/);
});

test('RU avatar form deletes its staged upload when the shared quota is exhausted', async () => {
  const f = fixture(); const calls = [];
  await initializeAvatarWorkflow({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: student }) };
    if (url === '/api/v1/avatars/media/pending') return { ok: true, json: async () => ({ ok: true, image: { key: 'pending/11111111-1111-4111-8111-111111111111/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp' } }) };
    if (url === '/api/v1/me/avatar') return { ok: false, status: 429, json: async () => ({ ok: false, error: 'rate_limited' }) };
    if (url === '/api/v1/media/pending/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') return { ok: true, json: async () => ({ ok: true, deleted: true }) };
    throw new Error(`unexpected route ${url}`);
  } });
  const form = f.elements.ruAvatarWorkflow.children.find(item => item.tagName === 'form');
  form.children[0].children[0].files = [{ type: 'image/png', size: 42, name: 'synthetic.png' }];
  await form.listeners.submit({ preventDefault() {} });
  assert.ok(calls.some(call => call.url === '/api/v1/media/pending/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' && call.init.method === 'DELETE'));
});

test('RU staff avatar review uses only validated same-origin image routes and refreshes after approval', async () => {
  const f = fixture(); const calls = []; let queued = true;
  await initializeAvatarWorkflow({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: staff }) };
    if (url === '/api/v1/avatars/moderation') return { ok: true, json: async () => ({ ok: true, requests: queued ? [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', photo_url: photoUrl, created_at: '2026-11-14T10:00:00Z' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', photo_url: 'https://evil.example/photo.webp' },
    ] : [] }) };
    if (url === `/api/v1/avatars/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/moderation`) { queued = false; return { ok: true, json: async () => ({ ok: true }) }; }
    throw new Error(`unexpected route ${url}`);
  } });
  assert.equal(f.elements.ruModeration.hidden, false);
  const reviewPanel = f.elements.ruAvatarReviewQueue.children[0];
  const list = reviewPanel.children.find(item => item.className === 'ru-avatar-review-list');
  assert.equal(list.children.length, 1);
  const card = list.children[0];
  assert.equal(card.children.find(item => item.tagName === 'img').src, photoUrl);
  const actions = card.children.find(item => item.className === 'ru-moderation-actions');
  await actions.children[0].listeners.click();
  assert.ok(calls.some(call => call.url === `/api/v1/avatars/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/moderation` && call.init.method === 'PATCH'));
  assert.match(reviewPanel.children[1].textContent, /нет/);
});

test('RU avatar workflow stays hidden for guests and rejects invalid image types', async () => {
  const guest = fixture();
  await initializeAvatarWorkflow({ ...guest, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(guest.elements.ruAvatarWorkflow.hidden, true);

  const f = fixture(); let fetchCount = 0;
  await initializeAvatarWorkflow({ ...f, fetchImpl: async () => { fetchCount++; return { ok: true, json: async () => ({ ok: true, profile: student }) }; } });
  const form = f.elements.ruAvatarWorkflow.children.find(item => item.tagName === 'form');
  form.children[0].children[0].files = [{ type: 'image/svg+xml', size: 20 }];
  const result = await form.listeners.submit({ preventDefault() {} });
  assert.equal(result, undefined);
  assert.equal(fetchCount, 1);
  assert.match(f.elements.ruAvatarWorkflow.children[1].textContent, /JPEG, PNG или WebP/);
});
