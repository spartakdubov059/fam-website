import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeSchoolPulse } from '../../web/pulse.js';
import { initializeHeroCarousel } from '../../web/hero-carousel.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.offsetLeft = 0; this.scrollLeft = 0; this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  dispatchEvent(event) { this.listeners[event.type]?.(event); }
  querySelector() { return null; }
  scrollTo({ left }) { this.scrollLeft = left; }
}
function fixture({ withHero = false } = {}) {
  const root = new FakeNode('section');
  const track = new FakeNode('div'); const dots = new FakeNode('div');
  if (withHero) track.children = [new FakeNode('div'), new FakeNode('div')];
  const document = { getElementById: id => id === 'ruPulse' ? root : id === 'ruHeroTrack' && withHero ? track : id === 'ruHeroDots' && withHero ? dots : null, createElement: tag => new FakeNode(tag) };
  return { root, track, dots, document };
}

test('school feed renders announcements as text and a student can cast one same-school poll vote', async () => {
  const f = fixture(); const calls = []; let voted = false;
  await initializeSchoolPulse({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'student-a', school_id: 'school-a', role: 'student' } }) };
    if (url === '/api/v1/pulse') return { ok: true, json: async () => ({ ok: true,
      announcements: [{ id: 'notice-a', title: '<img onerror=alert(1)>', body: 'Школьная новость', kind: 'important', published_at: '2027-01-01T10:00:00Z' }],
      polls: [{ id: 'poll-a', question: 'Какую книгу обсудим?', options: ['Первый', 'Второй', 'Третий', 'Четвертый', 'Пятый', 'Шестой', 'Седьмой', 'Восьмой'], closes_at: '2099-01-01T00:00:00Z', total_votes: voted ? 1 : 0, my_vote: voted ? 7 : null, counts: null }],
    }) };
    if (url === '/api/v1/pulse/polls/poll-a/votes') { voted = true; return { ok: true, status: 201, json: async () => ({ ok: true, voted: true }) }; }
    throw new Error(`unexpected URL ${url}`);
  } });
  assert.equal(f.root.children[1].textContent, '');
  const feed = f.root.children[2];
  const notice = feed.children[0];
  assert.equal(notice.children[1].textContent, '<img onerror=alert(1)>');
  assert.equal(notice.children[1].children.length, 0);
  const poll = feed.children[1];
  assert.equal(poll.children[2].children.length, 8, 'all eight source-compatible choices render');
  const lastVote = poll.children[2].children[7].children[0];
  await lastVote.listeners.click();
  assert.equal(calls.find(call => call.url.endsWith('/votes')).init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/votes')).init.body), { choice_index: 7 });
  const updatedPoll = f.root.children[2].children[1];
  assert.ok(updatedPoll.children[2].children.every(option => option.children[0].disabled), 'a submitted vote is not offered a second time');
});

test('school feed renders mixed cards in FAM priority order', async () => {
  const f = fixture();
  await initializeSchoolPulse({ ...f, fetchImpl: async url => url === '/api/v1/me'
    ? { ok: true, json: async () => ({ ok: true, profile: { id: 'student', school_id: 'school-a', role: 'student' } }) }
    : { ok: true, json: async () => ({ ok: true,
      announcements: [
        { id: 'news', title: 'Обычная новость', body: 'Текст', kind: 'news' },
        { id: 'event', title: 'Открытое событие', body: 'Текст', kind: 'open_event' },
        { id: 'important', title: 'Важное', body: 'Текст', kind: 'important' },
      ],
      polls: [{ id: 'poll', question: 'Вопрос?', options: ['Да', 'Нет'], closes_at: '2099-01-01T00:00:00Z' }],
    }) } });
  const cards = f.root.children[2].children;
  assert.deepEqual(cards.map(card => card.className), [
    'ru-pulse-card ru-pulse-important',
    'ru-pulse-card ru-pulse-event',
    'ru-pulse-card ru-pulse-poll',
    'ru-pulse-card ru-pulse-news',
  ]);
});

test('school feed is private for guests and publisher controls appear only for trusted school roles', async () => {
  const guest = fixture();
  await initializeSchoolPulse({ ...guest, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.match(guest.root.children[1].textContent, /Войдите через Яндекс ID/);
  assert.equal(guest.root.children[2].children[0].href, '/auth/yandex/start');

  const student = fixture();
  await initializeSchoolPulse({ ...student, fetchImpl: async url => url === '/api/v1/me'
    ? { ok: true, json: async () => ({ ok: true, profile: { id: 'student', school_id: 'school-a', role: 'student' } }) }
    : { ok: true, json: async () => ({ ok: true, announcements: [], polls: [] }) } });
  assert.equal(student.root.children[2].children.some(node => node.className === 'ru-pulse-publish'), false);

  const admin = fixture();
  const requests = [];
  await initializeSchoolPulse({ ...admin, fetchImpl: async (url, init = {}) => {
    requests.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'admin', school_id: 'school-a', role: 'school_admin' } }) };
    if (url === '/api/v1/pulse') return { ok: true, json: async () => ({ ok: true, announcements: [], polls: [] }) };
    if (url === '/api/v1/pulse/announcements') return { ok: true, status: 201, json: async () => ({ ok: true }) };
    throw new Error(`unexpected URL ${url}`);
  } });
  const panel = admin.root.children[2].children.find(node => node.className === 'ru-pulse-publish');
  const form = panel.children[1];
  assert.equal(panel.children[2].children.length, 11, 'publisher has a question, eight choices, submit and status');
  form.children[0].value = 'Новость школы'; form.children[1].value = 'В пятницу будет собрание';
  await form.listeners.submit({ preventDefault() {} });
  const sent = requests.find(call => call.url === '/api/v1/pulse/announcements');
  assert.deepEqual(Object.keys(JSON.parse(sent.init.body)).sort(), ['body', 'event_starts_at', 'kind', 'title']);
  assert.equal(JSON.parse(sent.init.body).school_id, undefined, 'the browser cannot choose announcement school or author');
});

test('guests see only future open events without registration limits from the public board', async () => {
  const f = fixture(); const calls = [];
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await initializeSchoolPulse({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: false, status: 401, json: async () => ({}) };
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: 'open', title: 'Открытая встреча', description: 'Можно прийти всем', is_event: true, max_seats: 0, event_date: today },
      { id: 'no-date', title: 'Без даты', description: 'Открытое событие', is_event: true, max_seats: 0, event_date: null },
      { id: 'limited', title: 'Запись', description: 'Есть места', is_event: true, max_seats: 20, event_date: today },
      { id: 'past', title: 'Прошедшее', description: 'Вчера', is_event: true, max_seats: 0, event_date: yesterday },
      { id: 'listing', title: 'Объявление', description: 'Не мероприятие', is_event: false, max_seats: 0 },
    ] }) };
    throw new Error(`unexpected URL ${url}`);
  } });

  assert.equal(calls[1].url, '/api/v1/listings');
  assert.equal(calls[1].init.credentials, 'omit');
  const feed = f.root.children[2];
  assert.deepEqual(feed.children.map(card => card.children[1]?.textContent), ['Открытая встреча', 'Без даты']);
  assert.ok(feed.children.every(card => card.className.includes('ru-pulse-event')));
  assert.equal(feed.children[0].children[2].textContent, 'Можно прийти всем');
  assert.equal(feed.children.some(card => JSON.stringify(card).includes('limited')), false);
});

test('guest feed does not claim open events loaded when the public listing API fails', async () => {
  const f = fixture();
  await initializeSchoolPulse({ ...f, fetchImpl: async url => url === '/api/v1/me'
    ? { ok: false, status: 401, json: async () => ({}) }
    : { ok: false, status: 503, json: async () => ({ ok: false }) } });
  assert.match(f.root.children[1].textContent, /Не удалось загрузить открытые мероприятия/);
  assert.equal(f.root.children[2].children[0].href, '/auth/yandex/start');
});

test('poll vote distribution is shown only to voters or after the poll closes', async () => {
  async function renderPoll(poll) {
    const f = fixture();
    await initializeSchoolPulse({ ...f, fetchImpl: async url => url === '/api/v1/me'
      ? { ok: true, json: async () => ({ ok: true, profile: { id: 'student', school_id: 'school-a', role: 'student' } }) }
      : { ok: true, json: async () => ({ ok: true, announcements: [], polls: [poll] }) } });
    return f.root.children[2].children[0];
  }

  const base = { id: 'poll-a', question: 'Какой вариант?', options: ['Первый', 'Второй'], total_votes: 5,
    counts: [4, 1], closes_at: '2099-01-01T00:00:00Z', my_vote: null };
  const openPoll = await renderPoll(base);
  assert.equal(openPoll.children[2].children[0].children.some(child => child.className === 'ru-pulse-vote-count'), false,
    'an open poll does not reveal the distribution before this participant votes');
  assert.equal(openPoll.children[2].children[0].children[0].tagName, 'button');

  const inconsistentPoll = await renderPoll({ ...base, my_vote: 0, counts: [4, 0] });
  assert.equal(inconsistentPoll.children[2].children[0].children.some(child => child.className === 'ru-pulse-vote-count'), false,
    'an inconsistent aggregate is not rendered as poll results');

  const voterPoll = await renderPoll({ ...base, my_vote: 0 });
  assert.equal(voterPoll.children[2].children[0].children[0].textContent, 'Ваш выбор: Первый');
  assert.equal(voterPoll.children[2].children[0].children[1].textContent, '80%');

  const closedPoll = await renderPoll({ ...base, closes_at: '2020-01-01T00:00:00Z' });
  assert.equal(closedPoll.children[2].children[1].children[1].textContent, '20%');
  assert.equal(closedPoll.children[2].children[0].children[0].tagName, 'span');
});

test('featured school cards join the hero carousel and preserve poll voting handlers', async () => {
  const f = fixture({ withHero: true }); let voted = false;
  initializeHeroCarousel({ document: f.document });
  assert.equal(f.dots.children.length, 2);
  await initializeSchoolPulse({ ...f, fetchImpl: async url => {
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'student', school_id: 'school-a', role: 'student' } }) };
    if (url === '/api/v1/pulse/polls/poll-a/votes') { voted = true; return { ok: true, status: 201, json: async () => ({ ok: true }) }; }
    if (url === '/api/v1/pulse') return { ok: true, json: async () => ({ ok: true, announcements: [
      { id: 'notice-a', title: 'Важная новость', body: 'Текст', kind: 'important' },
    ], polls: [{ id: 'poll-a', question: 'Выбор?', options: ['Да', 'Нет'], closes_at: '2099-01-01T00:00:00Z', total_votes: voted ? 1 : 0, my_vote: voted ? 0 : null }] }) };
    throw new Error(`unexpected URL ${url}`);
  } });

  assert.equal(f.track.children.length, 4);
  assert.equal(f.dots.children.length, 4, 'carousel navigation matches the newly featured cards');
  assert.equal(f.track.children[0].className.includes('hero-pulse-important'), true);
  assert.equal(f.track.children[1].className.includes('hero-pulse-poll'), true);
  assert.equal(f.root.children[2].children.length, 2, 'featured cards remain available in the Afisha feed');
  const pollCard = f.track.children[1].children[0];
  await pollCard.children[2].children[0].children[0].listeners.click();
  assert.equal(voted, true, 'moving the card preserves its vote handler');
  assert.equal(f.track.children[1].children[0].children[2].children[0].children[0].disabled, true,
    'a successful vote reloads the carousel card with the updated state');
  assert.equal(f.root.children[2].children[1].children[2].children[0].children[0].disabled, true,
    'the matching Afisha card also reflects the updated vote state');
});
