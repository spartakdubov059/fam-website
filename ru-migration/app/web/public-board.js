const MAX_PUBLIC_LISTINGS = 100;

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function loadPublicBoard({ root, document = globalThis.document, fetchImpl = globalThis.fetch }) {
  if (!root || !document || typeof fetchImpl !== 'function') throw new TypeError('public board dependencies are required');
  root.replaceChildren(element(document, 'p', 'ru-board-status', 'Загружаем объявления…'));
  try {
    const response = await fetchImpl('/api/v1/listings', { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('listing_read_unavailable');
    const result = await response.json();
    if (!result?.ok || !Array.isArray(result.listings) || result.listings.length > MAX_PUBLIC_LISTINGS) throw new Error('invalid_listing_response');
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
      if (listing.is_event === true) card.append(element(document, 'p', 'ru-listing-event', 'Мероприятие'));
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
