const STATUSES = Object.freeze({ active: 'Опубликовано', pending: 'На проверке', rejected: 'Отклонено', archived: 'Снято с публикации' });
const PHOTOS = Object.freeze({ none: 'Без фото', pending: 'Фото ожидает проверки', approved: 'Фото проверено', rejected: 'Фото отклонено' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function element(document, tag, className, text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  result.textContent = text;
  return result;
}

async function readJson(response) { try { return await response.json(); } catch { return null; } }

export async function initializeOwnListings({ document = globalThis.document, fetchImpl = globalThis.fetch,
  confirmImpl = message => typeof globalThis.confirm === 'function' && globalThis.confirm(message) } = {}) {
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
    if (UUID.test(listing.id)) {
      const actions = element(document, 'div', 'ru-own-listing-actions');
      const remove = element(document, 'button', 'ru-own-listing-delete', 'Удалить своё объявление');
      remove.type = 'button';
      const deleteStatus = element(document, 'p', 'ru-own-listing-status', '');
      deleteStatus.setAttribute('role', 'status'); deleteStatus.setAttribute('aria-live', 'polite');
      let busy = false;
      remove.addEventListener('click', async () => {
        if (busy) return;
        if (typeof confirmImpl !== 'function' || !confirmImpl(`Удалить объявление «${listing.title.slice(0, 80)}»? Его нельзя будет восстановить.`)) return;
        busy = true; remove.disabled = true; deleteStatus.textContent = 'Удаляем объявление…';
        try {
          const response = await fetchImpl(`/api/v1/listings/${listing.id}`, {
            method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
          });
          const result = await readJson(response);
          if (response.status === 401) deleteStatus.textContent = 'Сеанс завершён. Войдите и попробуйте снова.';
          else if (response.status === 403) deleteStatus.textContent = 'Удаление недоступно для этого аккаунта.';
          else if (!response.ok || result?.deleted !== true) deleteStatus.textContent = 'Не удалось удалить объявление. Обновите страницу и попробуйте ещё раз.';
          else {
            remove.disabled = true; remove.textContent = 'Удалено';
            deleteStatus.textContent = result.image_cleanup === 'queued'
              ? 'Объявление удалено; фото будет очищено позже.' : 'Объявление удалено.';
          }
        } catch { deleteStatus.textContent = 'Нет связи с сервером. Объявление не удалено.'; }
        finally { busy = false; if (remove.textContent !== 'Удалено') remove.disabled = false; }
      });
      actions.append(remove, deleteStatus); card.append(actions);
    }
    cards.append(card);
  }
  section.append(cards); section.hidden = false;
}

if (globalThis.document) initializeOwnListings();
