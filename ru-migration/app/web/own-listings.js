const STATUSES = Object.freeze({ active: 'Опубликовано', pending: 'На проверке', rejected: 'Отклонено', archived: 'Снято с публикации' });
const PHOTOS = Object.freeze({ none: 'Без фото', pending: 'Фото ожидает проверки', approved: 'Фото проверено', rejected: 'Фото отклонено' });

function element(document, tag, className, text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  result.textContent = text;
  return result;
}

async function readJson(response) { try { return await response.json(); } catch { return null; } }

export async function initializeOwnListings({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  const section = document?.getElementById?.('ruOwnListings');
  if (!section || typeof fetchImpl !== 'function') return;
  const status = element(document, 'p', 'ru-note', 'Загружаем ваши объявления…');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  section.replaceChildren(element(document, 'h2', '', 'Мои объявления'), status);
  let response; let result;
  try {
    response = await fetchImpl('/api/v1/me/listings', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    result = await readJson(response);
  } catch {
    status.textContent = 'Не удалось загрузить объявления. Проверьте соединение и попробуйте позже.';
    section.hidden = false;
    return;
  }
  if (response.status === 401) { section.hidden = true; return; }
  if (!response.ok || !result?.ok || !Array.isArray(result.listings)) {
    status.textContent = 'Список объявлений временно недоступен.';
    section.hidden = false;
    return;
  }
  const listings = result.listings.slice(0, 100).filter(item => item && typeof item.id === 'string'
    && typeof item.title === 'string' && Object.hasOwn(STATUSES, item.status));
  if (!listings.length) {
    status.textContent = 'У вас пока нет объявлений.';
    section.hidden = false;
    return;
  }
  status.remove();
  const cards = document.createElement('div'); cards.className = 'ru-own-listings-grid';
  for (const listing of listings) {
    const card = element(document, 'article', 'ru-own-listing');
    card.append(element(document, 'h3', '', listing.title.slice(0, 80)));
    card.append(element(document, 'p', 'ru-note', `Статус: ${STATUSES[listing.status]}`));
    if (typeof listing.description === 'string' && listing.description) card.append(element(document, 'p', '', listing.description.slice(0, 1000)));
    const meta = [typeof listing.category === 'string' ? listing.category.slice(0, 40) : '',
      typeof listing.price_text === 'string' ? listing.price_text.slice(0, 50) : '',
      Object.hasOwn(PHOTOS, listing.photo_status) ? PHOTOS[listing.photo_status] : ''].filter(Boolean).join(' · ');
    if (meta) card.append(element(document, 'p', 'ru-note', meta));
    cards.append(card);
  }
  section.append(cards); section.hidden = false;
}

if (globalThis.document) initializeOwnListings();
