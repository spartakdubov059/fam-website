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
  const previous = new FakeNode(); const next = new FakeNode();
  const document = { createElement: () => new FakeNode(), getElementById: id => ({
    ruHeroTrack: track, ruHeroDots: dots, ruHeroPrevious: previous, ruHeroNext: next,
  })[id] || null };
  return { document, track, dots, previous, next };
}

test('banner carousel creates accessible dots and advances through local slides', () => {
  const f = fixture();
  initializeHeroCarousel({ document: f.document });
  assert.equal(f.dots.children.length, 3);
  assert.match(f.dots.children[0].getAttribute('aria-label'), /Баннер 1/);
  f.next.listeners.click();
  assert.equal(f.track.scrollLeft, 320);
  assert.equal(f.dots.children[1].getAttribute('aria-pressed'), 'true');
  f.previous.listeners.click();
  assert.equal(f.track.scrollLeft, 0);
  assert.equal(f.dots.children[0].getAttribute('aria-pressed'), 'true');
});

test('banner carousel dots select a slide without autoplay', () => {
  const f = fixture();
  initializeHeroCarousel({ document: f.document });
  f.dots.children[2].listeners.click();
  assert.equal(f.track.scrollLeft, 640);
  assert.equal(f.dots.children[2].getAttribute('aria-pressed'), 'true');
});
