import { containsContactData, findLocalPolicyFlag } from './content-safety.js';

const KINDS = new Set(['news', 'important', 'open_event']);
const DAY = 24 * 60 * 60 * 1000;

function safeText(value) {
  return typeof value === 'string' && !containsContactData(value) && !findLocalPolicyFlag(value);
}

export function validateSchoolAnnouncement(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'invalid_announcement' };
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const kind = input.kind ?? 'news';
  if (title.length < 4 || title.length > 90 || body.length < 4 || body.length > 450
      || !KINDS.has(kind) || !safeText(title) || !safeText(body)) return { ok: false, code: 'invalid_announcement' };
  let eventStartsAt = null;
  if (kind === 'open_event') {
    eventStartsAt = typeof input.event_starts_at === 'string' ? Date.parse(input.event_starts_at) : NaN;
    if (!Number.isFinite(eventStartsAt) || eventStartsAt < now + 10 * 60 * 1000 || eventStartsAt > now + 90 * DAY) {
      return { ok: false, code: 'invalid_announcement' };
    }
  } else if (input.event_starts_at !== undefined && input.event_starts_at !== null && input.event_starts_at !== '') {
    return { ok: false, code: 'invalid_announcement' };
  }
  return { ok: true, announcement: { title, body, kind, event_starts_at: eventStartsAt === null ? null : new Date(eventStartsAt).toISOString() } };
}

export function validateSchoolPoll(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'invalid_poll' };
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (question.length < 8 || question.length > 140 || !safeText(question) || !Array.isArray(input.options)
      || input.options.length < 2 || input.options.length > 4) return { ok: false, code: 'invalid_poll' };
  const options = input.options.map(value => typeof value === 'string' ? value.trim() : '');
  if (options.some(value => value.length < 2 || value.length > 70 || !safeText(value))) return { ok: false, code: 'invalid_poll_options' };
  const normalized = options.map(value => value.normalize('NFKC').toLocaleLowerCase('ru'));
  if (new Set(normalized).size !== normalized.length) return { ok: false, code: 'duplicate_poll_options' };
  const closesAt = input.closes_at === undefined ? now + 7 * DAY : Date.parse(input.closes_at);
  if (!Number.isFinite(closesAt) || closesAt <= now || closesAt > now + 14 * DAY) return { ok: false, code: 'invalid_poll_close' };
  return { ok: true, poll: { question, options, closes_at: new Date(closesAt).toISOString() } };
}
