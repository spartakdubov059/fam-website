import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeCategoryHints, suggestListingCategories } from '../../web/category-hints.js';

test('local category hints prioritize clear listing intent and normalize ё', () => {
  assert.deepEqual(suggestListingCategories('Продам телефон', ''), ['Вещи']);
  assert.deepEqual(suggestListingCategories('Подготовка к ЕГЭ по математике', ''), ['Учёба']);
  assert.deepEqual(suggestListingCategories('Кружок по рисованию', 'Творческая мастерская'), ['Творчество']);
});

test('category hints omit event suggestions for users without event permissions', () => {
  assert.deepEqual(suggestListingCategories('Квиз для школы', '', { allowEvents: false }), []);
  assert.deepEqual(suggestListingCategories('Квиз для школы', '', { allowEvents: true }), ['Мероприятия']);
});

test('category hint UI only reads local fields and reacts to typing', () => {
  class Element {
    constructor(value = '') { this.value = value; this.options = []; this.listeners = {}; this.children = []; this._textContent = ''; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
    append(...children) { this.children.push(...children); }
    set textContent(value) { this._textContent = value; this.children = []; }
    get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  }
  const title = new Element();
  const description = new Element();
  const category = new Element('Учёба'); category.options = [{ value: 'Мероприятия', hidden: true }];
  const form = { elements: { title, description, category } };
  const hint = new Element();
  const document = {
    getElementById: id => ({ ruListingForm: form, ruCategoryHint: hint })[id],
    createElement: () => new Element(), createTextNode: text => new Element(text),
  };
  initializeCategoryHints({ document });
  title.value = 'Продам учебник';
  title.dispatchEvent(new Event('input'));
  assert.match(hint.textContent, /Вещи/);
  assert.doesNotMatch(hint.textContent, /Мероприятия/);
  const thingSuggestion = hint.children.find(child => child.textContent === 'Вещи');
  assert.ok(thingSuggestion);
  thingSuggestion.dispatchEvent(new Event('click'));
  assert.equal(category.value, 'Вещи');
  assert.match(hint.textContent, /подходит категория «Вещи»/);
});
