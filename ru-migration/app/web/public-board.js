import { initializeMessages } from './messages.js';

const MAX_PUBLIC_LISTINGS = 100;
const BOARD_CATEGORIES = ['Все', 'Вещи', 'Услуги', 'Творчество', 'Учёба', 'Мероприятия'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let messagesInitialized = false;

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function loadMyEventRegistrations(fetchImpl) {
  try {
    const response = await fetchImpl('/api/v1/event-registrations', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    });
    if (response.status === 401) return { state: 'guest', registrations: new Map() };
    if (!response.ok) return { state: 'unavailable', registrations: new Map() };
    const result = await response.json();
    if (!result?.ok || !Array.isArray(result.registrations)) return { state: 'unavailable', registrations: new Map() };
    return { state: 'authenticated', registrations: new Map(result.registrations
      .filter(row => row && typeof row.event_id === 'string' && typeof row.status === 'string')
      .map(row => [row.event_id, row])) };
  } catch {
    return { state: 'unavailable', registrations: new Map() };
  }
}

async function loadMyFavorites(fetchImpl) {
  try {
    const response = await fetchImpl('/api/v1/favorites', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (response.status === 401) return { state: 'guest', ids: new Set() };
    if (!response.ok) return { state: 'unavailable', ids: new Set() };
    const result = await response.json();
    if (!result?.ok || !Array.isArray(result.favorite_ids)) return { state: 'unavailable', ids: new Set() };
    return { state: 'authenticated', ids: new Set(result.favorite_ids.filter(id => typeof id === 'string' && UUID.test(id))) };
  } catch { return { state: 'unavailable', ids: new Set() }; }
}

async function loadMyActiveListingIds(fetchImpl) {
  try {
    const response = await fetchImpl('/api/v1/me/listings', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return new Set();
    const result = await response.json();
    return result?.ok && Array.isArray(result.listing_ids)
      ? new Set(result.listing_ids.filter(id => typeof id === 'string' && UUID.test(id))) : new Set();
  } catch { return new Set(); }
}

function addOwnListingDeleteControl({ card, listing, document, fetchImpl, ownListingIds, confirmImpl }) {
  if (!UUID.test(listing.id) || !ownListingIds.has(listing.id)) return;
  const actions = element(document, 'div', 'ru-own-listing-actions');
  const button = element(document, 'button', 'ru-own-listing-delete', 'Удалить своё объявление');
  button.type = 'button';
  const status = element(document, 'p', 'ru-own-listing-status', '');
  status.setAttribute('role', 'status');
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    if (typeof confirmImpl !== 'function') { status.textContent = 'Удаление недоступно в этом браузере.'; return; }
    if (!confirmImpl(`Удалить объявление «${listing.title || 'Без названия'}»? Его нельзя будет восстановить.`)) return;
    busy = true; button.disabled = true; status.textContent = '';
    try {
      const response = await fetchImpl(`/api/v1/listings/${listing.id}`, {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (response.status === 401) status.textContent = 'Сеанс завершён. Войдите, чтобы удалить объявление.';
      else if (response.status === 403) status.textContent = 'Удаление доступно только владельцу обычного аккаунта.';
      else if (!response.ok || result?.deleted !== true) status.textContent = 'Не удалось удалить объявление. Обновите страницу и попробуйте ещё раз.';
      else {
        ownListingIds.delete(listing.id);
        status.textContent = result.image_cleanup === 'queued' ? 'Объявление удалено; фото будет очищено позже.' : 'Объявление удалено.';
        button.textContent = 'Удалено';
        card.hidden = true;
      }
    } catch {
      status.textContent = 'Нет связи с сервером. Объявление не удалено.';
    } finally {
      busy = false;
      if (ownListingIds.has(listing.id)) button.disabled = false;
    }
  });
  actions.append(button, status);
  card.append(actions);
}

function addFavoriteControl({ card, listing, document, fetchImpl, favorites, location }) {
  if (!UUID.test(listing.id)) return;
  const actions = element(document, 'div', 'ru-favorite-actions');
  const button = element(document, 'button', 'ru-favorite-toggle', '');
  button.type = 'button';
  const status = element(document, 'p', 'ru-favorite-status', '');
  status.setAttribute('role', 'status');
  let busy = false;
  const update = () => {
    button.disabled = busy || favorites.state === 'unavailable';
    button.textContent = favorites.state === 'unavailable' ? 'Избранное недоступно'
      : favorites.ids.has(listing.id) ? 'Убрать из избранного'
        : favorites.state === 'guest' ? 'Войти и добавить в избранное' : 'В избранное';
    button.setAttribute('aria-pressed', String(favorites.ids.has(listing.id)));
  };
  button.addEventListener('click', async () => {
    if (busy || favorites.state === 'unavailable') return;
    if (favorites.state === 'guest') { location?.assign?.('/auth/yandex/start'); return; }
    busy = true; status.textContent = ''; update();
    const favorited = !favorites.ids.has(listing.id);
    try {
      const response = await fetchImpl(`/api/v1/listings/${listing.id}/favorite`, {
        method: favorited ? 'PUT' : 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (response.status === 401) {
        favorites.state = 'guest';
        status.textContent = 'Сеанс завершён. Войдите, чтобы изменить избранное.';
      } else if (!response.ok || result?.favorited !== favorited) {
        status.textContent = 'Не удалось обновить избранное. Попробуйте позже.';
      } else {
        if (favorited) favorites.ids.add(listing.id); else favorites.ids.delete(listing.id);
        status.textContent = favorited ? 'Добавлено в избранное.' : 'Удалено из избранного.';
      }
    } catch { status.textContent = 'Нет связи с сервером. Попробуйте ещё раз.'; }
    finally { busy = false; update(); }
  });
  update();
  actions.append(button, status);
  card.append(actions);
}

function addListingContactForm({ card, listing, document, fetchImpl, favorites, location }) {
  if (!UUID.test(listing.id)) return;
  const form = document.createElement('form');
  form.className = 'ru-contact-form';
  const input = document.createElement('textarea');
  input.name = 'body'; input.maxLength = 1000; input.required = true;
  input.placeholder = 'Сообщение автору'; input.setAttribute('aria-label', 'Сообщение автору объявления');
  const submit = element(document, 'button', 'ru-contact-submit', 'Написать автору');
  submit.type = 'submit';
  const status = element(document, 'p', 'ru-contact-status', '');
  status.setAttribute('role', 'status');
  let busy = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = input.value.trim();
    if (busy || !body || body.length > 1000) return;
    if (favorites.state === 'guest') { location?.assign?.('/auth/yandex/start'); return; }
    if (favorites.state !== 'authenticated') { status.textContent = 'Отправка сейчас недоступна.'; return; }
    busy = true; submit.disabled = true; status.textContent = '';
    try {
      const response = await fetchImpl(`/api/v1/listings/${listing.id}/contact`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ body }),
      });
      const result = await response.json().catch(() => null);
      if (response.status === 401) {
        favorites.state = 'guest'; status.textContent = 'Сеанс завершён. Войдите, чтобы написать.';
      } else if (response.status === 503 && result?.status === 'pending') {
        status.textContent = 'Сообщение не отправлено: проверка безопасности временно недоступна.';
      } else if (!response.ok || !result?.ok) {
        status.textContent = response.status === 404 ? 'Объявление или его автор больше недоступны.' : 'Не удалось отправить сообщение. Проверьте текст и попробуйте позже.';
      } else {
        input.value = ''; status.textContent = 'Сообщение отправлено после проверки. Ответ появится во вкладке «Чат».';
      }
    } catch { status.textContent = 'Нет связи с сервером. Попробуйте ещё раз.'; }
    finally { busy = false; submit.disabled = false; }
  });
  form.append(input, submit, status); card.append(form);
}

function formatEventTime(listing) {
  const parts = [];
  if (typeof listing.event_date === 'string' && listing.event_date) parts.push(listing.event_date);
  if (typeof listing.event_time === 'string' && listing.event_time) parts.push(listing.event_time);
  return parts.join(' · ');
}

function addEventRegistrationControls({ card, listing, document, fetchImpl, session, location }) {
  if (!listing.is_event || !UUID.test(listing.id)) return;
  const details = formatEventTime(listing);
  if (details) card.append(element(document, 'p', 'ru-listing-event-time', details));
  if (listing.event_type === 'limited' && Number.isInteger(listing.max_seats) && listing.max_seats > 0) {
    card.append(element(document, 'p', 'ru-listing-event-seats', `Мест всего: ${listing.max_seats}`));
  }

  const actions = element(document, 'div', 'ru-event-actions');
  const status = element(document, 'p', 'ru-event-action-status', '');
  status.setAttribute('role', 'status');
  const register = element(document, 'button', 'ru-event-register', '');
  register.type = 'button';
  const cancel = element(document, 'button', 'ru-event-cancel', 'Отменить запись');
  cancel.type = 'button';
  let busy = false;

  const current = () => session.registrations.get(listing.id);
  const updateControls = () => {
    const registration = current();
    cancel.hidden = !registration || !['pending', 'confirmed'].includes(registration.status);
    if (session.state === 'unavailable') {
      register.textContent = 'Запись недоступна'; register.disabled = true;
    } else if (registration?.status === 'pending') {
      register.textContent = 'Заявка отправлена'; register.disabled = true;
    } else if (registration?.status === 'confirmed') {
      register.textContent = 'Вы записаны'; register.disabled = true;
    } else if (session.state === 'guest') {
      register.textContent = 'Войти и записаться'; register.disabled = false;
    } else {
      register.textContent = listing.event_type === 'request' ? 'Подать заявку' : 'Записаться';
      register.disabled = false;
    }
    cancel.disabled = busy;
    if (busy) register.disabled = true;
  };

  register.addEventListener('click', async () => {
    if (busy) return;
    if (session.state === 'guest') {
      location?.assign?.('/auth/yandex/start');
      return;
    }
    if (session.state !== 'authenticated') return;
    busy = true; status.textContent = ''; updateControls();
    try {
      const response = await fetchImpl(`/api/v1/listings/${listing.id}/registrations`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      });
      let result = {};
      try { result = await response.json(); } catch { /* use the HTTP status */ }
      if (response.status === 401) {
        session.state = 'guest';
        status.textContent = 'Сеанс завершён. Войдите, чтобы продолжить.';
      } else if (response.status === 409 && result.error === 'no_seats_available') {
        status.textContent = 'Свободных мест больше нет.';
      } else if (response.status === 409 && result.error === 'already_registered') {
        status.textContent = 'Вы уже записаны на это мероприятие.';
      } else if (response.status === 403 && result.error === 'organizer_cannot_register') {
        status.textContent = 'Организатор не может записаться на своё мероприятие.';
      } else if (!response.ok || !result?.registration) {
        status.textContent = 'Не удалось отправить запись. Попробуйте позже.';
      } else {
        session.registrations.set(listing.id, result.registration);
        status.textContent = result.registration.status === 'pending' ? 'Заявка отправлена организатору.' : 'Вы записаны на мероприятие.';
      }
    } catch {
      status.textContent = 'Нет связи с сервером. Попробуйте ещё раз.';
    } finally {
      busy = false; updateControls();
    }
  });

  cancel.addEventListener('click', async () => {
    if (busy) return;
    busy = true; status.textContent = ''; updateControls();
    try {
      const response = await fetchImpl(`/api/v1/listings/${listing.id}/registrations/me`, {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      });
      if (response.status === 401) {
        session.state = 'guest';
        status.textContent = 'Сеанс завершён. Войдите, чтобы изменить запись.';
      } else if (!response.ok) {
        status.textContent = 'Не удалось отменить запись. Попробуйте позже.';
      } else {
        session.registrations.set(listing.id, { event_id: listing.id, status: 'cancelled' });
        status.textContent = 'Запись отменена.';
      }
    } catch {
      status.textContent = 'Нет связи с сервером. Попробуйте ещё раз.';
    } finally {
      busy = false; updateControls();
    }
  });

  updateControls();
  actions.append(register, cancel);
  card.append(actions, status);
}

export async function loadPublicBoard({ root, document = globalThis.document, fetchImpl = globalThis.fetch, location = document?.defaultView?.location ?? globalThis.location, confirmImpl = globalThis.confirm?.bind(globalThis) }) {
  if (!root || !document || typeof fetchImpl !== 'function') throw new TypeError('public board dependencies are required');
  if (document.getElementById && !document.getElementById('ruOpenMessages')) {
    const open = element(document, 'button', 'ru-button', 'Личные сообщения');
    open.id = 'ruOpenMessages'; open.type = 'button'; open.setAttribute('aria-expanded', 'false');
    const panel = element(document, 'section', 'ru-messages', '');
    panel.id = 'ruMessages'; panel.hidden = true; panel.setAttribute('aria-label', 'Личные сообщения');
    const heading = element(document, 'h2', '', 'Личные сообщения');
    const status = element(document, 'p', 'ru-messages-status', 'Войдите, чтобы открыть переписку.');
    status.id = 'ruMessagesStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const back = element(document, 'button', 'ru-button', 'К списку диалогов');
    back.id = 'ruMessagesBack'; back.type = 'button'; back.hidden = true;
    const list = element(document, 'div', 'ru-message-list', ''); list.id = 'ruMessageList';
    const form = document.createElement('form'); form.id = 'ruMessageForm'; form.className = 'ru-message-form'; form.hidden = true;
    const input = document.createElement('input'); input.name = 'body'; input.maxLength = 1000; input.required = true;
    input.autocomplete = 'off'; input.placeholder = 'Написать ответ'; input.setAttribute('aria-label', 'Текст ответа');
    const send = element(document, 'button', 'ru-message-send', 'Отправить'); send.type = 'submit';
    form.append(input, send); panel.append(heading, status, back, list, form);
    root.parentNode?.insertBefore(open, root);
    root.parentNode?.insertBefore(panel, root.nextSibling);
  }
  if (document.getElementById && !messagesInitialized) {
    messagesInitialized = true;
    void initializeMessages({ document, fetchImpl, location });
  }
  root.replaceChildren(element(document, 'p', 'ru-board-status', 'Загружаем объявления…'));
  try {
    const response = await fetchImpl('/api/v1/listings', { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('listing_read_unavailable');
    const result = await response.json();
    if (!result?.ok || !Array.isArray(result.listings) || result.listings.length > MAX_PUBLIC_LISTINGS) throw new Error('invalid_listing_response');
    const events = result.listings.some(listing => listing?.is_event === true);
    const session = events ? await loadMyEventRegistrations(fetchImpl) : { state: 'guest', registrations: new Map() };
    if (result.listings.length === 0) {
      root.replaceChildren(element(document, 'p', 'ru-board-status', 'Пока нет опубликованных объявлений. Новые объявления появятся после проверки администрацией школы.'));
      return;
    }
    const favorites = await loadMyFavorites(fetchImpl);
    const ownListingIds = await loadMyActiveListingIds(fetchImpl);
    const cards = [];
    for (const listing of result.listings) {
      if (!listing || typeof listing.id !== 'string' || typeof listing.title !== 'string'
          || typeof listing.description !== 'string' || typeof listing.category !== 'string') continue;
      const card = element(document, 'article', 'ru-listing-card');
      card.append(element(document, 'p', 'ru-listing-category', listing.category));
      card.append(element(document, 'h2', 'ru-listing-title', listing.title));
      if (listing.photo_url === `/api/v1/listings/${listing.id}/photo`) {
        const photo = document.createElement('img');
        photo.className = 'ru-listing-photo';
        photo.src = listing.photo_url;
        photo.alt = `Фото: ${listing.title}`;
        photo.loading = 'lazy';
        photo.referrerPolicy = 'no-referrer';
        card.append(photo);
      }
      card.append(element(document, 'p', 'ru-listing-description', listing.description));
      card.append(element(document, 'p', 'ru-listing-price', typeof listing.price_text === 'string' ? listing.price_text : ''));
      addOwnListingDeleteControl({ card, listing, document, fetchImpl, ownListingIds, confirmImpl });
      addFavoriteControl({ card, listing, document, fetchImpl, favorites, location });
      addListingContactForm({ card, listing, document, fetchImpl, favorites, location });
      if (listing.is_event === true) {
        card.append(element(document, 'p', 'ru-listing-event', 'Мероприятие'));
        addEventRegistrationControls({ card, listing, document, fetchImpl, session, location });
      }
      cards.push({ card, listing });
    }
    if (cards.length === 0) throw new Error('invalid_listing_response');

    const toolbar = element(document, 'div', 'ru-board-controls');
    const search = document.createElement('input');
    search.type = 'search'; search.maxLength = 120; search.placeholder = 'Поиск по объявлениям';
    search.setAttribute('aria-label', 'Поиск по объявлениям');
    const filters = element(document, 'div', 'ru-board-categories');
    filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Категории объявлений');
    const count = element(document, 'p', 'ru-board-count', ''); count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite');
    let category = 'Все';
    const filterButtons = new Map();
    const updateResults = () => {
      const query = String(search.value || '').trim().toLocaleLowerCase('ru');
      let visible = 0;
      for (const { card, listing } of cards) {
        const categoryMatches = category === 'Все' || listing.category === category;
        const searchable = [listing.title, listing.description, listing.category, listing.price_text]
          .filter(value => typeof value === 'string').join(' ').toLocaleLowerCase('ru');
        const textMatches = !query || searchable.includes(query);
        card.hidden = !categoryMatches || !textMatches;
        if (!card.hidden) visible++;
      }
      for (const [name, button] of filterButtons) button.setAttribute('aria-pressed', String(name === category));
      count.textContent = visible === 0 ? 'Ничего не найдено. Измените запрос или категорию.' : `Показано ${visible} из ${cards.length} объявлений.`;
    };
    const categories = [...BOARD_CATEGORIES];
    for (const { listing } of cards) {
      if (typeof listing.category === 'string' && listing.category.length <= 40
          && !categories.includes(listing.category) && categories.length < 12) categories.push(listing.category);
    }
    for (const name of categories) {
      const button = element(document, 'button', 'ru-board-category', name);
      button.type = 'button'; button.setAttribute('aria-pressed', String(name === category));
      button.addEventListener('click', () => { category = name; updateResults(); });
      filterButtons.set(name, button); filters.append(button);
    }
    search.addEventListener('input', updateResults);
    toolbar.append(search, filters, count);
    root.replaceChildren(toolbar, ...cards.map(item => item.card));
    updateResults();
  } catch {
    const error = element(document, 'p', 'ru-board-status', 'Не удалось загрузить объявления. Проверьте подключение и попробуйте ещё раз.');
    error.setAttribute('role', 'status');
    const retry = element(document, 'button', 'ru-board-retry', 'Повторить');
    retry.type = 'button';
    retry.addEventListener('click', () => { void loadPublicBoard({ root, document, fetchImpl }); });
    root.replaceChildren(error, retry);
  }
}

if (globalThis.document) {
  const root = globalThis.document.getElementById('publicListings');
  if (root) void loadPublicBoard({ root });
}
