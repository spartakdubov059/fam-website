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
  const listeners = {};
  const title = { value: '', addEventListener: (name, fn) => { listeners[`title:${name}`] = fn; } };
  const description = { value: '', addEventListener: (name, fn) => { listeners[`description:${name}`] = fn; } };
  const category = { value: 'Учёба', options: [{ value: 'Мероприятия', hidden: true }] };
  const form = { elements: { title, description, category } };
  const hint = { textContent: '' };
  const document = { getElementById: id => ({ ruListingForm: form, ruCategoryHint: hint })[id] };
  initializeCategoryHints({ document });
  title.value = 'Продам учебник';
  listeners['title:input']();
  assert.match(hint.textContent, /Вещи/);
  assert.doesNotMatch(hint.textContent, /Мероприятия/);
});
