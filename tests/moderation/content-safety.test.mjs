import test from "node:test";
import assert from "node:assert/strict";
import { containsContactData, findLocalPolicyFlag } from "../../supabase/functions/moderate/content-safety.js";

test("detects common contact details before text reaches an external provider", () => {
  assert.equal(containsContactData("Мой телефон: +7 900 123-45-67"), true);
  assert.equal(containsContactData("Почта: learner@example.ru"), true);
  assert.equal(containsContactData("Ссылка: https://example.ru/profile"), true);
  assert.equal(containsContactData("Мой профиль @student_2026"), true);
  assert.equal(containsContactData("Адрес: ул. Тестовая, дом 12"), true);
});

test("detects simple obfuscated email formats", () => {
  assert.equal(containsContactData("learner собака example точка ru"), true);
});

test("does not treat ordinary school text, dates, or common words as contact data", () => {
  assert.equal(containsContactData("Посадим траву возле школы. Дата: 08.11.2026."), false);
  assert.equal(containsContactData("Доклад по криптографии и математике."), false);
  assert.equal(containsContactData("На урок принесли ножницы и соль для опыта."), false);
});

test("local idea checks flag sensitive topics without matching ordinary substrings", () => {
  assert.equal(findLocalPolicyFlag("Предлагаю обсудить вред вейпов.")?.code, "nicotine_or_alcohol");
  assert.equal(findLocalPolicyFlag("Посадить траву на клумбе.") , null);
  assert.equal(findLocalPolicyFlag("Доклад по криптографии.") , null);
  assert.equal(findLocalPolicyFlag("Принести ножницы на урок труда.") , null);
});
