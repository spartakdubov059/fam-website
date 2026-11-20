import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeIdeaHistory } from '../../web/idea-history.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = false; this.textContent = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
function fixture() {
  const root = new Element('section');
  const document = { getElementById: id => id === 'ruIdeaHistory' ? root : null, createElement: tag => new Element(tag) };
  return { root, document };
}

test('idea history renders only bounded own API fields as text and private image routes', async () => {
  const f = fixture();
  await initializeIdeaHistory({ ...f, fetchImpl: async (url, options) => {
    assert.equal(url, '/api/v1/me/ideas');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    return { ok: true, status: 200, json: async () => ({ ok: true, ideas: [{
      id: '11111111-1111-4111-8111-111111111111', text: '<script>нет</script>', admin_status: 'in_progress',
      ai_status: 'approved', image_status: 'pending', image_count: 1, created_at: '2026-11-20T12:00:00Z',
    }] }) };
  } });
  assert.equal(f.root.hidden, false);
  const card = f.root.children[2].children[0];
  assert.equal(card.children[0].textContent, '<script>нет</script>');
  assert.equal(card.children[0].children.length, 0);
  assert.equal(card.children[1].textContent, 'В работе');
  assert.equal(card.children[2].children[0].src, '/api/v1/ideas/11111111-1111-4111-8111-111111111111/images/0');
});

test('idea history stays hidden for guests and displays no ideas when the list is empty', async () => {
  const guest = fixture();
  await initializeIdeaHistory({ ...guest, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(guest.root.hidden, true);
  const empty = fixture();
  await initializeIdeaHistory({ ...empty, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ideas: [] }) }) });
  assert.equal(empty.root.hidden, false);
  assert.match(empty.root.children[1].textContent, /ещё не отправляли/);
});
