import test from 'node:test';
import assert from 'node:assert/strict';
import { containsContactData as sourceContainsContactData, findLocalPolicyFlag as sourceFindLocalPolicyFlag }
  from '../../../../supabase/functions/moderate/content-safety.js';
import { containsContactData, findLocalPolicyFlag } from '../policies/content-safety.js';

test('RU contact-data screening matches the source moderation rules on shared Russian fixtures', () => {
  const fixtures = [
    ['ученик@example.ru', true],
    ['номер +7 (999) 111-22-33', true],
    ['встреча на улице Ленина, д. 5', true],
    ['пишите @user_name', true],
    ['ссылка vk.com/example', true],
    ['обычная школьная викторина 12.03.2026', false],
    ['помощь с учебником математики', false],
    ['contact [at] example [dot] ru', true],
  ];

  for (const [text, expected] of fixtures) {
    assert.equal(sourceContainsContactData(text), expected, `source contact fixture: ${text}`);
    assert.equal(containsContactData(text), expected, `RU contact fixture: ${text}`);
  }
});

test('RU retains the source local policy categories for shared restricted-content fixtures', () => {
  const fixtures = [
    ['Продам наркотики', 'controlled_substances'],
    ['Кальян и табак', 'nicotine_or_alcohol'],
    ['Казино и ставки на спорт', 'restricted_or_adult_content'],
    ['Угрозы и расправа', 'serious_hate_or_threat'],
    ['Обычный учебник по алгебре', null],
  ];

  for (const [text, expected] of fixtures) {
    assert.equal(sourceFindLocalPolicyFlag(text)?.code ?? null, expected, `source category fixture: ${text}`);
    assert.equal(findLocalPolicyFlag(text)?.code ?? null, expected, `RU category fixture: ${text}`);
  }
});

test('RU safety-review signals remain explicit local additions over the source rules', () => {
  const fixtures = [
    ['Разговор о суициде и поиске помощи.', 'self_harm_safety_review'],
    ['Поступили сообщения о сексуальном насилии.', 'sexual_safety_review'],
    ['Как сообщить о травле в школе?', 'violence_safety_review'],
  ];

  for (const [text, expected] of fixtures) {
    assert.equal(findLocalPolicyFlag(text)?.code, expected);
  }
});
