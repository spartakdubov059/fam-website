const MAX_PUBLIC_LISTINGS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export async function loadPublicBoard({ root, document = globalThis.document, fetchImpl = globalThis.fetch, location = document?.defaultView?.location ?? globalThis.location }) {
  if (!root || !document || typeof fetchImpl !== 'function') throw new TypeError('public board dependencies are required');
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
    const fragment = document.createDocumentFragment();
    for (const listing of result.listings) {
      if (!listing || typeof listing.id !== 'string' || typeof listing.title !== 'string'
          || typeof listing.description !== 'string' || typeof listing.category !== 'string') continue;
      const card = element(document, 'article', 'ru-listing-card');
      card.append(element(document, 'p', 'ru-listing-category', listing.category));
      card.append(element(document, 'h2', 'ru-listing-title', listing.title));
      card.append(element(document, 'p', 'ru-listing-description', listing.description));
      card.append(element(document, 'p', 'ru-listing-price', typeof listing.price_text === 'string' ? listing.price_text : ''));
      if (listing.is_event === true) {
        card.append(element(document, 'p', 'ru-listing-event', 'Мероприятие'));
        addEventRegistrationControls({ card, listing, document, fetchImpl, session, location });
      }
      fragment.append(card);
    }
    if (fragment.childNodes.length === 0) throw new Error('invalid_listing_response');
    root.replaceChildren(fragment);
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
