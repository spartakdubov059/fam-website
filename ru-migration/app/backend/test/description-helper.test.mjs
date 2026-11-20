import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDescriptionTemplate, getMissingDescriptionSuggestions, initializeDescriptionHelper, normalizeDescriptionDraft,
} from '../../web/description-helper.js';

test('description helper normalizes punctuation and capitalization without changing words', () => {
  assert.equal(normalizeDescriptionDraft('  привет!!как   дела  \nвсё хорошо '), 'Привет! Как дела.\nВсё хорошо.');
});

test('description templates are category-specific, factual placeholders and local', () => {
  const event = buildDescriptionTemplate({ title: 'Книжный обмен', category: 'Мероприятия' });
  assert.match(event, /Книжный обмен/);
  assert.match(event, /публичную площадку, не домашний адрес/);
  assert.doesNotMatch(event, /Цена:/);
  const item = buildDescriptionTemplate({ title: 'Велосипед', category: 'Вещи', price: '5000' });
  assert.match(item, /Цена: 5000/);
  assert.match(item, /\[укажите реальное состояние\]/);
  assert.deepEqual(getMissingDescriptionSuggestions({ category: 'Услуги', description: 'Онлайн, расписание по договорённости', price: '' }), [
    'что входит в услугу', 'кому подходит услуга', 'стоимость или отметку «Бесплатно»',
  ]);
});

test('description helper preview applies only after explicit action and validates the draft', () => {
  class Element {
    constructor(value = '') { this.value = value; this.textContent = ''; this.hidden = false; this.listeners = {}; this.focused = false; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
    focus() { this.focused = true; }
  }
  const title = new Element('Кружок по рисованию');
  const description = new Element('');
  const category = new Element('Творчество');
  const price = new Element('');
  const form = { elements: { title, description, category, price_text: price } };
  const ids = ['ruDescriptionHelperToggle', 'ruDescriptionHelper', 'ruDescriptionDraft', 'ruDescriptionHelperNote', 'ruDescriptionSuggestions', 'ruDescriptionApply', 'ruDescriptionClose'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const document = { getElementById: id => id === 'ruListingForm' ? form : elements[id] };
  initializeDescriptionHelper({ document });
  assert.equal(description.value, '');
  elements.ruDescriptionHelperToggle.dispatchEvent(new Event('click'));
  assert.equal(elements.ruDescriptionHelper.hidden, false);
  assert.match(elements.ruDescriptionDraft.value, /\[опишите результат\]/);
  elements.ruDescriptionDraft.value = '  готовый   текст ';
  elements.ruDescriptionApply.dispatchEvent(new Event('click'));
  assert.equal(description.value, 'готовый   текст');
  assert.equal(description.focused, true);
  elements.ruDescriptionDraft.value = 'x'.repeat(1001);
  elements.ruDescriptionApply.dispatchEvent(new Event('click'));
  assert.match(elements.ruDescriptionHelperNote.textContent, /длиннее лимита/);
  assert.equal(description.value, 'готовый   текст');
});
