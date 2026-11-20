import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeHeroCarousel } from '../../web/hero-carousel.js';

class FakeNode {
  constructor({ offsetLeft = 0, alt = '' } = {}) {
    this.offsetLeft = offsetLeft; this.alt = alt; this.scrollLeft = 0;
    this.children = []; this.attributes = {}; this.listeners = {}; this.classList = { toggle: () => {} };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  dispatchEvent(event) { this.listeners[event.type]?.(event); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector(selector) { return selector === 'img' ? this.image : null; }
  scrollTo({ left }) { this.scrollLeft = left; this.listeners.scroll?.(); }
}
function fixture() {
  const track = new FakeNode();
  track.children = [0, 320, 640].map((offsetLeft, index) => {
    const slide = new FakeNode({ offsetLeft }); slide.image = new FakeNode({ alt: `Баннер ${index + 1}` }); return slide;
  });
  const dots = new FakeNode();
  const rotation = new FakeNode();
  const previous = new FakeNode(); const next = new FakeNode();
  const callbacks = new Map(); let timerId = 0;
  const timerApi = {
    setInterval(callback, delay) { const id = ++timerId; callbacks.set(id, { callback, delay }); return id; },
    clearInterval(id) { callbacks.delete(id); },
    tick() { for (const timer of callbacks.values()) timer.callback(); },
    get activeCount() { return callbacks.size; },
    get delays() { return [...callbacks.values()].map(timer => timer.delay); },
  };
  const eventListeners = {};
  const document = { createElement: () => new FakeNode(), getElementById: id => ({
    ruHeroTrack: track, ruHeroDots: dots, ruHeroRotation: rotation, ruHeroPrevious: previous, ruHeroNext: next,
  })[id] || null, hidden: false, addEventListener: (name, fn) => { eventListeners[name] = fn; },
    defaultView: { matchMedia: () => ({ matches: false }) } };
  return { document, track, dots, rotation, previous, next, timerApi, eventListeners };
}

test('banner carousel creates accessible dots and advances through local slides', () => {
  const f = fixture();
  initializeHeroCarousel({ document: f.document, timerApi: f.timerApi });
  assert.equal(f.dots.children.length, 3);
  assert.match(f.dots.children[0].getAttribute('aria-label'), /Баннер 1/);
  f.next.listeners.click();
  assert.equal(f.track.scrollLeft, 320);
  assert.equal(f.dots.children[1].getAttribute('aria-pressed'), 'true');
  f.previous.listeners.click();
  assert.equal(f.track.scrollLeft, 0);
  assert.equal(f.dots.children[0].getAttribute('aria-pressed'), 'true');
});

test('banner carousel rotates automatically and can be paused by the user', () => {
  const f = fixture();
  initializeHeroCarousel({ document: f.document, timerApi: f.timerApi });
  assert.deepEqual(f.timerApi.delays, [4200]);
  assert.equal(f.rotation.getAttribute('aria-label'), 'Остановить автопрокрутку');
  f.timerApi.tick();
  assert.equal(f.track.scrollLeft, 320);
  f.rotation.listeners.click();
  assert.equal(f.timerApi.activeCount, 0);
  assert.equal(f.rotation.getAttribute('aria-pressed'), 'false');
  f.dots.children[2].listeners.click();
  assert.equal(f.track.scrollLeft, 640);
  assert.equal(f.dots.children[2].getAttribute('aria-pressed'), 'true');
});

test('carousel rebuilds accessible dots when school feed slides are added dynamically', () => {
  const f = fixture();
  initializeHeroCarousel({ document: f.document, timerApi: f.timerApi });
  const pulse = new FakeNode({ offsetLeft: 0 });
  f.track.children.unshift(pulse);
  f.track.children.slice(1).forEach((slide, index) => { slide.offsetLeft = (index + 1) * 320; });
  f.track.dispatchEvent(new Event('famru:hero-slides-changed'));
  assert.equal(f.dots.children.length, 4);
  assert.equal(f.track.scrollLeft, 320, 'the currently selected original banner remains selected after insertion');
  f.dots.children[0].listeners.click();
  assert.equal(f.track.scrollLeft, 0);
  assert.equal(f.dots.children[0].getAttribute('aria-pressed'), 'true');
});

test('carousel pauses for keyboard focus and reduced-motion preference', () => {
  const f = fixture();
  initializeHeroCarousel({ document: f.document, timerApi: f.timerApi });
  assert.equal(f.timerApi.activeCount, 1);
  f.document.hidden = true;
  f.eventListeners.visibilitychange();
  assert.equal(f.timerApi.activeCount, 0, 'a hidden page does not rotate slides');
  f.document.hidden = false;
  f.eventListeners.visibilitychange();
  assert.equal(f.timerApi.activeCount, 1, 'rotation resumes when the visible page returns');
  f.track.listeners.focusin();
  assert.equal(f.timerApi.activeCount, 0);
  assert.equal(f.rotation.getAttribute('aria-label'), 'Включить автопрокрутку');

  const reduced = fixture();
  reduced.document.defaultView.matchMedia = () => ({ matches: true });
  initializeHeroCarousel({ document: reduced.document, timerApi: reduced.timerApi });
  assert.equal(reduced.timerApi.activeCount, 0);
  assert.equal(reduced.rotation.getAttribute('aria-pressed'), 'false');
  reduced.rotation.listeners.click();
  assert.equal(reduced.timerApi.delays[0], 4200, 'a user can explicitly enable rotation');
});
