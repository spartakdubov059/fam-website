import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicBoard } from '../../web/public-board.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.hidden = false; this.open = false; }
  get childNodes() { return this.children; }
  append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parentNode = this; }
  replaceChildren(...nodes) { this.children = nodes; }
  insertBefore(node, reference) { const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parentNode = this; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.({ target: this }); }
  focus() { this.focused = true; }
}
function boardCard(root, index = 0) { return root.children.filter(node => node.className === 'ru-listing-card')[index]; }

function createFakeDocument() {
  const listeners = {}; const pulseCards = [];
  const pulseRoot = new FakeNode('section'); pulseRoot.id = 'ruPulse';
  const heading = new FakeNode('h2'); heading.textContent = 'Новости и опросы школы';
  const pulseFeed = new FakeNode('div'); pulseFeed.className = 'ru-pulse-feed'; pulseRoot.append(heading, pulseFeed);
  return {
    pulseCards,
    pulseRoot,
    body: new FakeNode('body'),
    createElement: tag => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
    querySelectorAll: selector => selector === '#ruPulse .ru-pulse-card' ? pulseCards : [],
    getElementById: id => id === 'ruPulse' ? pulseRoot : null,
    addEventListener: (name, handler) => { listeners[name] = handler; },
    dispatchEvent: event => listeners[event.type]?.(event),
  };
}

test('school board request includes the same-origin session and writes listing data as text', async () => {
  const root = new FakeNode('section');
  let options;
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async (url, init) => {
    if (url === '/api/v1/listings') options = { url, init };
    return { ok: true, json: async () => ({ ok: true, listings: [{ id: 'listing-1', title: '<script>alert(1)</script>', description: 'Синтетическое описание', category: 'Учёба', price_text: 'Бесплатно', is_event: false }] }) };
  } });
  assert.equal(options.url, '/api/v1/listings');
  assert.equal(options.init.credentials, 'same-origin');
  assert.equal(options.init.cache, 'no-store');
  const title = boardCard(root).children[1];
  assert.equal(title.textContent, '<script>alert(1)</script>');
  assert.equal(title.children.length, 0, 'untrusted listing title is never parsed as markup');
});

test('listing details open an accessible modal with safe text and only the approved same-origin photo route', async () => {
  const root = new FakeNode('section'); const document = createFakeDocument();
  const malicious = '<img src=x onerror=alert(1)>';
  await loadPublicBoard({ root, document, fetchImpl: async url => url === '/api/v1/listings'
    ? { ok: true, json: async () => ({ ok: true, listings: [{ id: 'listing-safe', title: malicious,
      description: malicious, category: 'Афиша', price_text: '1 250 ₽', created_at: '2026-11-20T12:00:00Z',
      is_event: true, event_date: '2026-12-01', event_time: '18:30', photo_url: '/api/v1/listings/listing-safe/photo' }] }) }
    : { ok: false, status: 401, json: async () => ({}) } });
  const card = boardCard(root);
  const detailsButton = card.children.find(node => node.className === 'l-details-btn');
  const dialog = root.children.find(node => node.tagName === 'dialog');
  assert.ok(detailsButton);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'ruListingDetailsTitle');
  detailsButton.listeners.click({ currentTarget: detailsButton });
  assert.equal(dialog.open, true);
  const panel = dialog.children[0];
  const header = panel.children[0];
  assert.equal(header.children[0].textContent, malicious);
  const body = panel.children[1];
  const image = body.children.find(node => node.tagName === 'img');
  assert.equal(image.src, '/api/v1/listings/listing-safe/photo');
  const description = body.children.find(node => node.className === 'listing-detail-description');
  assert.equal(description.textContent, malicious);
  assert.equal(description.children.length, 0, 'untrusted description is never parsed as markup');
  assert.match(body.children.find(node => node.className === 'listing-detail-meta').textContent, /Афиша.*декабря.*18:30/);
  header.children[1].listeners.click();
  assert.equal(dialog.open, false);
  assert.equal(detailsButton.focused, true, 'closing the modal restores focus to its opener');
});


test('public board filters the approved result set by Russian category and text without another request', async () => {
  const root = new FakeNode('section');
  let listingRequests = 0;
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async url => {
    if (url === '/api/v1/listings') {
      listingRequests++;
      return { ok: true, json: async () => ({ ok: true, listings: [
        { id: 'listing-a', title: 'Словарь русского языка', description: 'Для школы', category: 'Учёба', price_text: '300 ₽' },
        { id: 'listing-b', title: 'Настольная игра', description: 'Для друзей', category: 'Вещи', price_text: 'Бесплатно' },
      ] }) };
    }
    return { ok: false, status: 401, json: async () => ({}) };
  } });
  const toolbar = root.children[0];
  const search = toolbar.children[0];
  const filters = toolbar.children.find(node => node.className === 'ru-board-categories');
  const cards = root.children.filter(node => node.className === 'ru-listing-card');
  const study = filters.children.find(button => button.textContent === 'Учёба');
  study.listeners.click();
  assert.equal(cards[0].hidden, false);
  assert.equal(cards[1].hidden, true);
  assert.equal(study.getAttribute('aria-pressed'), 'true');
  search.value = 'настольная'; search.listeners.input();
  assert.equal(cards[0].hidden, true);
  assert.equal(cards[1].hidden, true, 'category and text filters are combined');
  assert.match(toolbar.children.find(node => node.className === 'ru-board-count').textContent, /Ничего не найдено/);
  const all = filters.children.find(button => button.textContent === 'Все');
  all.listeners.click();
  assert.equal(cards[0].hidden, true);
  assert.equal(cards[1].hidden, false);
  assert.equal(listingRequests, 1, 'filters operate only on the already-authorized public response');
});

test('Afisha search, category and result count include school announcements and polls', async () => {
  const root = new FakeNode('section'); const document = createFakeDocument();
  await loadPublicBoard({ root, document, fetchImpl: async url => url === '/api/v1/listings'
    ? { ok: true, json: async () => ({ ok: true, listings: [
      { id: 'event-a', title: 'Встреча', description: 'Общий зал', category: 'Афиша', is_event: true },
      { id: 'listing-a', title: 'Словарь', description: 'Учёба', category: 'Учёба', is_event: false },
    ] }) }
    : { ok: false, status: 401, json: async () => ({}) } });
  const notice = new FakeNode('article'); notice.className = 'ru-pulse-card ru-pulse-news'; notice.textContent = 'Школьная новость о ярмарке';
  notice.setAttribute('data-search', 'школьная новость о ярмарке');
  const poll = new FakeNode('article'); poll.className = 'ru-pulse-card ru-pulse-poll'; poll.textContent = 'Какую книгу обсудим?'; poll.setAttribute('data-search', 'какую книгу обсудим?');
  document.pulseCards.push(notice, poll);
  document.pulseRoot.children[1].append(notice, poll);
  document.dispatchEvent(new Event('famru:pulse-updated'));
  const toolbar = root.children[0]; const search = toolbar.children[0];
  const filters = toolbar.children.find(node => node.className === 'ru-board-categories');
  assert.equal(notice.hidden, true, 'school cards are shown only in the Afisha category');
  assert.equal(poll.hidden, true);
  filters.children.find(button => button.textContent === 'Афиша').listeners.click();
  assert.match(toolbar.children.find(node => node.className === 'ru-board-count').textContent, /Показано 3 материала/);
  search.value = 'книгу'; search.listeners.input();
  assert.equal(notice.hidden, true);
  assert.equal(poll.hidden, false);
  assert.equal(boardCard(root, 0).hidden, true);
  assert.equal(boardCard(root, 1).hidden, true);
  assert.match(toolbar.children.find(node => node.className === 'ru-board-count').textContent, /Показан 1 материал/);
  filters.children.find(button => button.textContent === 'Учёба').listeners.click();
  assert.equal(poll.hidden, true, 'school pulse cards are shown with the general board or Afisha filter');
  filters.children.find(button => button.textContent === 'Афиша').listeners.click();
  assert.equal(poll.hidden, false, 'Afisha filter includes matching school polls');
});

test('Afisha combines school posts and event listings in one ordered section and filters them together', async () => {
  const root = new FakeNode('section'); const document = createFakeDocument();
  const listings = [
    { id: 'market', title: 'Весенняя ярмарка', description: 'Школьная ярмарка', category: 'Афиша', price_text: 'Бесплатно', is_event: true, event_date: '2026-12-20', event_time: '12:00' },
    { id: 'lesson', title: 'Словарь', description: 'Для школы', category: 'Учёба', price_text: '300 ₽', is_event: false },
    { id: 'concert', title: 'Концерт', description: 'Музыка', category: 'Афиша', price_text: 'Бесплатно', is_event: true, event_date: '2026-12-10', event_time: '18:00' },
  ];
  await loadPublicBoard({ root, document, fetchImpl: async url => url === '/api/v1/listings'
    ? { ok: true, json: async () => ({ ok: true, listings }) }
    : { ok: false, status: 401, json: async () => ({}) } });
  const notice = new FakeNode('article'); notice.className = 'ru-pulse-card ru-pulse-news'; notice.setAttribute('data-search', 'школьная новость'); notice.setAttribute('data-sort-date', '2026-12-15T00:00:00Z');
  const poll = new FakeNode('article'); poll.className = 'ru-pulse-card ru-pulse-poll'; poll.setAttribute('data-search', 'какую книгу'); poll.setAttribute('data-sort-date', '2026-12-25T00:00:00Z');
  document.pulseCards.push(notice, poll);
  document.pulseRoot.children[1].append(notice, poll);
  document.dispatchEvent(new Event('famru:pulse-updated'));
  const toolbar = root.children[0]; const search = toolbar.children[0];
  const filters = toolbar.children.find(node => node.className === 'ru-board-categories');
  const afisha = filters.children.find(button => button.textContent === 'Афиша');
  afisha.listeners.click();
  assert.deepEqual(document.pulseRoot.children.slice(2), [boardCard(root, 2), notice, boardCard(root, 0), poll]);
  assert.equal(boardCard(root, 1).hidden, true, 'ordinary listings stay out of Afisha');
  assert.match(toolbar.children.find(node => node.className === 'ru-board-count').textContent, /Показано 4 материала/);
  search.value = 'концерт'; search.listeners.input();
  assert.equal(boardCard(root, 0).hidden, true);
  assert.equal(boardCard(root, 2).hidden, false);
  assert.equal(notice.hidden, true);
  assert.equal(poll.hidden, true);
  assert.match(toolbar.children.find(node => node.className === 'ru-board-count').textContent, /Показан 1 материал/);
});

test('authenticated board opens the saved favorites view and removes an item from it immediately', async () => {
  const root = new FakeNode('section');
  const favoriteId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: favoriteId, title: 'Сохранённая книга', description: 'В избранном', category: 'Учёба' },
      { id: otherId, title: 'Другая вещь', description: 'Обычное объявление', category: 'Вещи' },
    ] }) };
    if (url === '/api/v1/favorites') return { ok: true, json: async () => ({ ok: true, favorite_ids: [favoriteId] }) };
    if (url === '/api/v1/me/listings') return { ok: false, status: 401, json: async () => ({}) };
    if (url === `/api/v1/listings/${favoriteId}/favorite` && options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true, favorited: false }) };
    throw new Error(`unexpected request ${url}`);
  } });
  const toolbar = root.children[0];
  const viewButtons = toolbar.children.find(node => node.className === 'ru-board-views');
  const favoriteView = viewButtons.children.find(button => button.textContent === 'Избранное');
  const cards = root.children.filter(node => node.className === 'ru-listing-card');
  favoriteView.listeners.click();
  assert.equal(cards[0].hidden, false);
  assert.equal(cards[1].hidden, true);
  const toggle = cards[0].children.find(node => node.className === 'ru-favorite-actions').children[0];
  await toggle.listeners.click();
  assert.equal(cards[0].hidden, true, 'removing a favorite immediately removes it from the saved view');
  assert.match(toolbar.children.find(node => node.className === 'ru-board-count').textContent, /пока нет объявлений/);
  assert.equal(calls.some(call => call.options.method === 'DELETE'), true);
});

test('favorite navigation selected during loading is applied when the board arrives', async () => {
  const root = new FakeNode('section');
  root.setAttribute('data-ru-board-view', 'favorites');
  const savedId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async url => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: savedId, title: 'Сохранённое', description: 'Да', category: 'Учёба' },
      { id: otherId, title: 'Обычное', description: 'Нет', category: 'Вещи' },
    ] }) };
    if (url === '/api/v1/favorites') return { ok: true, json: async () => ({ ok: true, favorite_ids: [savedId] }) };
    return { ok: false, status: 401, json: async () => ({}) };
  } });
  const cards = root.children.filter(node => node.className === 'ru-listing-card');
  assert.equal(cards[0].hidden, false);
  assert.equal(cards[1].hidden, true);
});

test('guest board offers the same login prompt as the source FAM', async () => {
  const root = new FakeNode('section');
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async url => url === '/api/v1/listings'
    ? ({ ok: true, json: async () => ({ ok: true, listings: [] }) })
    : ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.match(root.children[0].textContent, /Войдите, чтобы смотреть объявления своей школы/);
  assert.equal(root.children[1].href, '/auth/yandex/start');
});

test('signed-in school board shows its normal empty state', async () => {
  const root = new FakeNode('section');
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async url => url === '/api/v1/listings'
    ? ({ ok: true, json: async () => ({ ok: true, listings: [] }) })
    : ({ ok: true, json: async () => ({ ok: true, favorite_ids: [] }) }) });
  assert.match(root.children[0].textContent, /Пока нет опубликованных объявлений/);
});

test('guest board offers retry when the Russian API is unavailable', async () => {
  const root = new FakeNode('section');
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('offline'); };
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl });
  assert.equal(root.children[0].attributes.role, 'status');
  assert.equal(root.children[1].textContent, 'Повторить');
  await root.children[1].listeners.click();
  assert.equal(calls, 2);
});

test('event card reads only the user own registrations and supports reservation and cancellation', async () => {
  const root = new FakeNode('section');
  const calls = [];
  const eventId = '11111111-1111-4111-8111-111111111111';
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: eventId, title: 'Синтетический концерт', description: 'Проверка записи', category: 'Афиша', price_text: 'Бесплатно', is_event: true, event_type: 'limited', max_seats: 12, event_date: '2099-05-01', event_time: '12:00' },
    ] }) };
    if (url === '/api/v1/event-registrations') return { ok: true, status: 200, json: async () => ({ ok: true, registrations: [] }) };
    if (url === '/api/v1/favorites') return { ok: true, status: 200, json: async () => ({ ok: true, favorite_ids: [] }) };
    if (url === '/api/v1/me/listings') return { ok: false, status: 401, json: async () => ({}) };
    if (url === `/api/v1/listings/${eventId}/registrations`) return { ok: true, status: 201, json: async () => ({ ok: true, registration: { event_id: eventId, user_id: 'synthetic-user', status: 'confirmed' } }) };
    if (url === `/api/v1/listings/${eventId}/registrations/me`) return { ok: true, status: 200, json: async () => ({ ok: true, status: 'cancelled' }) };
    throw new Error(`unexpected request ${url}`);
  } });
  const card = boardCard(root);
  const eventCategory = root.children[0].children.find(node => node.className === 'ru-board-categories').children.find(button => button.textContent === 'Афиша');
  assert.ok(eventCategory, 'categories returned by public listings are available as filters');
  const actions = card.children.find(node => node.className === 'ru-event-actions');
  const [register, cancel] = actions.children;
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(register.textContent, 'Записаться');
  assert.equal(cancel.hidden, true);
  await register.listeners.click();
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal(calls.at(-1).options.credentials, 'same-origin');
  assert.equal(register.textContent, 'Вы записаны');
  assert.equal(cancel.hidden, false);
  await cancel.listeners.click();
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(register.textContent, 'Записаться');
  assert.equal(cancel.hidden, true);
});

test('authenticated board users can toggle favorites through their own Russian API route', async () => {
  const root = new FakeNode('section');
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id, title: 'Учебник', description: 'Описание', category: 'Учёба', is_event: false },
    ] }) };
    if (url === '/api/v1/favorites') return { ok: true, json: async () => ({ ok: true, favorite_ids: [id] }) };
    return { ok: true, json: async () => ({ ok: true, favorited: options.method === 'PUT' }) };
  } });
  const card = boardCard(root);
  const actions = card.children.find(node => node.className === 'ru-favorite-actions');
  const [toggle] = actions.children;
  assert.equal(toggle.textContent, 'Убрать из избранного');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  await toggle.listeners.click();
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(toggle.textContent, 'В избранное');
  await toggle.listeners.click();
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.equal(toggle.textContent, 'Убрать из избранного');
  assert.equal(calls.at(-1).options.credentials, 'same-origin');
});

test('guest favorite action sends the user to Yandex login without a write', async () => {
  const root = new FakeNode('section');
  const id = '11111111-1111-4111-8111-111111111111';
  let loginUrl;
  let writes = 0;
  await loadPublicBoard({ root, document: createFakeDocument(), location: { assign: value => { loginUrl = value; } }, fetchImpl: async url => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [{ id, title: 'Учебник', description: '', category: 'Учёба' }] }) };
    if (url === '/api/v1/favorites' || url === '/api/v1/me/listings') return { ok: false, status: 401, json: async () => ({}) };
    if (options?.method === 'PUT' || options?.method === 'DELETE') writes++;
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const card = boardCard(root);
  const button = card.children.find(node => node.className === 'ru-favorite-actions').children[0];
  await button.listeners.click();
  assert.equal(loginUrl, '/auth/yandex/start');
  assert.equal(writes, 0);
});

test('only the authenticated owner sees the own-listing delete action, and confirmed deletion refreshes the card state', async () => {
  const root = new FakeNode('section');
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  let allowed = false;
  await loadPublicBoard({ root, document: createFakeDocument(), confirmImpl: () => allowed, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id, title: 'Моя книга', description: 'Описание', category: 'Учёба', price_text: 'Бесплатно' },
    ] }) };
    if (url === '/api/v1/favorites') return { ok: true, json: async () => ({ ok: true, favorite_ids: [] }) };
    if (url === '/api/v1/me/listings') return { ok: true, json: async () => ({ ok: true, listing_ids: [id] }) };
    if (url === `/api/v1/listings/${id}` && options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true, deleted: true, image_cleanup: 'not_needed' }) };
    throw new Error(`unexpected request ${url}`);
  } });
  const card = boardCard(root);
  const actions = card.children.find(node => node.className === 'ru-own-listing-actions');
  assert.ok(actions);
  const button = actions.children[0];
  await button.listeners.click();
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false, 'cancelled confirmation does not write');
  allowed = true;
  await button.listeners.click();
  const deletion = calls.find(call => call.options.method === 'DELETE');
  assert.equal(deletion.url, `/api/v1/listings/${id}`);
  assert.equal(deletion.options.credentials, 'same-origin');
  assert.equal(card.hidden, true);
  assert.equal(actions.children[1].textContent, 'Объявление удалено.');
});

test('guest event action redirects to Yandex login and unavailable event APIs disable registration', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const makeRoot = () => new FakeNode('section');
  const root = makeRoot();
  let loginUrl;
  await loadPublicBoard({ root, document: createFakeDocument(), location: { assign: value => { loginUrl = value; } }, fetchImpl: async url => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [{ id: eventId, title: 'Событие', description: '', category: 'Афиша', is_event: true }] }) };
    return { ok: false, status: 401, json: async () => ({}) };
  } });
  const actions = boardCard(root).children.find(node => node.className === 'ru-event-actions');
  await actions.children[0].listeners.click();
  assert.equal(loginUrl, '/auth/yandex/start');

  const unavailableRoot = makeRoot();
  await loadPublicBoard({ root: unavailableRoot, document: createFakeDocument(), fetchImpl: async url =>
    url === '/api/v1/listings'
      ? { ok: true, json: async () => ({ ok: true, listings: [{ id: eventId, title: 'Событие', description: '', category: 'Афиша', is_event: true }] }) }
      : { ok: false, status: 503, json: async () => ({}) },
  });
  const unavailableActions = boardCard(unavailableRoot).children.find(node => node.className === 'ru-event-actions');
  assert.equal(unavailableActions.children[0].disabled, true);
  assert.equal(unavailableActions.children[0].textContent, 'Запись недоступна');
});


test('Afisha filter selects event listings by event flag and excludes ordinary listings', async () => {
  const root = new FakeNode('section');
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async url => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: 'event-a', title: 'Концерт', description: 'Школьный концерт', category: 'Мероприятия', is_event: true },
      { id: 'listing-a', title: 'Обычное объявление', description: 'Текст', category: 'Мероприятия', is_event: false },
      { id: 'listing-b', title: 'Книга', description: 'Для школы', category: 'Учёба', is_event: false },
    ] }) };
    return { ok: false, status: 401, json: async () => ({}) };
  } });
  const toolbar = root.children[0];
  const filters = toolbar.children.find(node => node.className === 'ru-board-categories');
  const cards = root.children.filter(node => node.className === 'ru-listing-card');
  const afisha = filters.children.find(button => button.textContent === 'Афиша');
  assert.ok(afisha);
  afisha.listeners.click();
  assert.equal(cards[0].hidden, false);
  assert.equal(cards[1].hidden, true);
  assert.equal(cards[2].hidden, true);
  assert.equal(afisha.getAttribute('aria-pressed'), 'true');
});


test('limited event checks live seat availability only when requested', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const root = new FakeNode('section');
  let occupancyRequest;
  await loadPublicBoard({ root, document: createFakeDocument(), fetchImpl: async (url, options = {}) => {
    if (url === '/api/v1/listings') return { ok: true, json: async () => ({ ok: true, listings: [
      { id: eventId, title: 'Синтетическое мероприятие', description: 'Событие', category: 'Мероприятия',
        is_event: true, event_type: 'limited', max_seats: 8 },
    ] }) };
    if (url === '/api/v1/event-registrations' || url === '/api/v1/favorites' || url === '/api/v1/me/listings') {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    if (url === `/api/v1/listings/${eventId}/occupancy`) {
      occupancyRequest = { url, options };
      return { ok: true, json: async () => ({ ok: true, taken: 3 }) };
    }
    throw new Error(`unexpected request ${url}`);
  } });
  const card = boardCard(root);
  const check = card.children.find(node => node.className === 'ru-event-capacity-check');
  const status = card.children.find(node => node.className === 'ru-listing-event-occupancy');
  assert.ok(check);
  assert.equal(occupancyRequest, undefined, 'occupancy is not fetched automatically for every event card');
  await check.listeners.click();
  assert.equal(occupancyRequest.url, `/api/v1/listings/${eventId}/occupancy`);
  assert.equal(occupancyRequest.options.credentials, 'same-origin');
  assert.equal(occupancyRequest.options.cache, 'no-store');
  assert.equal(status.textContent, 'Свободно: 5 из 8 мест.');
});
