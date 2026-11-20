import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeNavigation } from '../../web/navigation.js';

class Node {
  constructor(id = '') { this.id = id; this.attributes = {}; this.listeners = {}; this.scrolled = null; this.clicked = 0; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  scrollIntoView(options) { this.scrolled = options; }
  click() { this.clicked++; this.listeners.click?.(); }
}
function fixture() {
  const buttons = ['board', 'afisha', 'messages', 'profile'].map(view => {
    const button = new Node(); button.setAttribute('data-ru-view', view); return button;
  });
  const nodes = new Map([
    ['ruTabbar', { querySelectorAll: () => buttons }],
    ['publicListings', new Node('publicListings')],
    ['ruBoardCategoryAfisha', new Node('ruBoardCategoryAfisha')],
    ['ruOpenMessages', new Node('ruOpenMessages')],
    ['ruMessages', new Node('ruMessages')],
    ['ruProfileSettings', new Node('ruProfileSettings')],
  ]);
  return { buttons, nodes, document: { getElementById: id => nodes.get(id) || null } };
}

test('mobile Afisha navigation selects the event filter and scrolls to the board', () => {
  const f = fixture();
  initializeNavigation({ document: f.document });
  f.buttons[1].listeners.click();
  assert.equal(f.nodes.get('ruBoardCategoryAfisha').clicked, 1);
  assert.deepEqual(f.nodes.get('publicListings').scrolled, { behavior: 'smooth', block: 'start' });
  assert.equal(f.buttons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(f.buttons[0].getAttribute('aria-pressed'), 'false');
});

test('mobile messages and profile navigation open or locate their same-page sections', () => {
  const f = fixture();
  initializeNavigation({ document: f.document });
  f.buttons[2].listeners.click();
  assert.equal(f.nodes.get('ruOpenMessages').clicked, 1);
  assert.deepEqual(f.nodes.get('ruMessages').scrolled, { behavior: 'smooth', block: 'start' });
  f.buttons[3].listeners.click();
  assert.deepEqual(f.nodes.get('ruProfileSettings').scrolled, { behavior: 'smooth', block: 'start' });
});


test('profile tab opens the signed-in idea history before settings', () => {
  const f = fixture();
  const history = new Node('ruIdeaHistory'); history.hidden = false;
  f.nodes.set('ruIdeaHistory', history);
  initializeNavigation({ document: f.document });
  f.buttons[3].listeners.click();
  assert.deepEqual(history.scrolled, { behavior: 'smooth', block: 'start' });
});
