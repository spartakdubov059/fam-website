import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchoolAnnouncement, validateSchoolPoll } from '../policies/pulse-policy.mjs';

const now = Date.parse('2027-01-01T00:00:00.000Z');

test('announcement policy bounds fields and open-event dates without external moderation', () => {
  assert.equal(validateSchoolAnnouncement({ title: 'Важное', body: 'Собрание в актовом зале', kind: 'news' }, now).ok, true);
  assert.equal(validateSchoolAnnouncement({ title: 'Встреча', body: 'Приходите на праздник', kind: 'open_event', event_starts_at: '2027-01-03T12:00:00.000Z' }, now).ok, true);
  assert.equal(validateSchoolAnnouncement({ title: 'Встреча', body: 'Приходите по адресу улица Ленина 12' }, now).ok, false);
  assert.equal(validateSchoolAnnouncement({ title: 'Встреча', body: 'Приходите на праздник', kind: 'open_event' }, now).ok, false);
  assert.equal(validateSchoolAnnouncement({ title: 'Важное', body: 'Ссылка https://example.com' }, now).ok, false);
});

test('poll policy requires unique safe choices and bounded closing time', () => {
  const valid = validateSchoolPoll({ question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика'] }, now);
  assert.equal(valid.ok, true);
  assert.equal(Date.parse(valid.poll.closes_at), now + 7 * 86400000);
  assert.equal(validateSchoolPoll({ question: 'Что выберем?', options: ['Один вариант', ' один вариант '] }, now).code, 'duplicate_poll_options');
  assert.equal(validateSchoolPoll({ question: 'Где встречаемся?', options: ['У школы', 'У дома 12345678901'] }, now).code, 'invalid_poll_options');
  assert.equal(validateSchoolPoll({ question: 'Какую книгу обсудим?', options: ['Сказки', 'Фантастика'], closes_at: '2027-01-20T00:00:00Z' }, now).code, 'invalid_poll_close');
});
