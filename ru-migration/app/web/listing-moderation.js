const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAFF_ROLES = new Set(['school_admin', 'council_member']);

function node(document, tag, className, text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  result.textContent = text;
  return result;
}

async function json(response) {
  try { return await response.json(); } catch { return null; }
}

export async function initializeListingModeration({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  if (!document || typeof fetchImpl !== 'function') return;
  const panel = document.getElementById('ruModeration');
  const status = document.getElementById('ruModerationStatus');
  const queue = document.getElementById('ruModerationQueue');
  if (!panel || !status || !queue) return;

  let me;
  try {
    const response = await fetchImpl('/api/v1/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return;
    me = await json(response);
  } catch { return; }
  if (!me?.ok || !STAFF_ROLES.has(me.profile?.role)) return;
  panel.hidden = false;

  async function load() {
    status.textContent = 'Загружаем очередь…';
    try {
      const options = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
      const [response, eventResponse] = await Promise.all([
        fetchImpl('/api/v1/listings/moderation', options),
        fetchImpl('/api/v1/event-registrations/review', options),
      ]);
      const [result, eventResult] = await Promise.all([json(response), json(eventResponse)]);
      if (!response.ok || !result?.ok || !Array.isArray(result.listings)
        || !eventResponse.ok || !eventResult?.ok || !Array.isArray(eventResult.applications)) throw new Error('queue_unavailable');
      queue.replaceChildren();
      const applications = eventResult.applications.filter(application => application
        && UUID.test(application.event_id) && UUID.test(application.user_id)
        && application.status === 'pending' && typeof application.event_title === 'string');
      if (result.listings.length === 0 && applications.length === 0) {
        status.textContent = 'Новых объявлений для проверки нет.';
        return;
      }
      status.textContent = `Ожидают проверки: объявлений — ${result.listings.length}, заявок на мероприятия — ${applications.length}.`;
      for (const listing of result.listings) {
        if (!listing || !UUID.test(listing.id) || typeof listing.title !== 'string' || typeof listing.description !== 'string') continue;
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', listing.title));
        card.append(node(document, 'p', '', `${listing.category || ''} · ${listing.price_text || 'Бесплатно'}`));
        card.append(node(document, 'p', '', listing.description));
        if (listing.photo_url === `/api/v1/listings/${listing.id}/photo` && ['pending', 'approved'].includes(listing.photo_status)) {
          const photo = document.createElement('img');
          photo.className = 'ru-listing-photo';
          photo.src = listing.photo_url;
          photo.alt = `Фото на проверке: ${listing.title}`;
          photo.loading = 'lazy';
          photo.referrerPolicy = 'no-referrer';
          card.append(photo);
        }
        const actions = node(document, 'div', 'ru-moderation-actions');
        if (listing.photo_status === 'pending') {
          actions.append(actionButton(document, 'Одобрить фото', () => decide(`/api/v1/listings/${listing.id}/photo`, 'approve')));
          actions.append(actionButton(document, 'Отклонить фото', () => decide(`/api/v1/listings/${listing.id}/photo`, 'reject')));
        }
        if (['none', 'approved'].includes(listing.photo_status)) {
          actions.append(actionButton(document, 'Опубликовать', () => decide(`/api/v1/listings/${listing.id}/moderation`, 'approve')));
        }
        actions.append(actionButton(document, 'Отклонить объявление', () => decide(`/api/v1/listings/${listing.id}/moderation`, 'reject')));
        card.append(actions);
        queue.append(card);
      }
      for (const application of applications) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', application.event_title));
        const name = [application.first_name, application.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
        card.append(node(document, 'p', '', `Заявка: ${name || 'Ученик'}${application.class_name ? ` · ${application.class_name}` : ''}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        const path = `/api/v1/listings/${application.event_id}/registrations/${application.user_id}`;
        actions.append(actionButton(document, 'Подтвердить заявку', () => decide(path, 'approve')));
        actions.append(actionButton(document, 'Отклонить заявку', () => decide(path, 'reject')));
        card.append(actions);
        queue.append(card);
      }
    } catch { status.textContent = 'Не удалось загрузить очередь. Проверьте подключение и попробуйте позже.'; }
  }

  async function decide(path, decision) {
    status.textContent = 'Сохраняем решение…';
    try {
      const response = await fetchImpl(path, { method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ decision }) });
      if (!response.ok) throw new Error('decision_failed');
      await load();
    } catch { status.textContent = 'Не удалось сохранить решение. Очередь не обновлена.'; }
  }

  await load();
}

function actionButton(document, label, handler) {
  const button = node(document, 'button', 'ru-button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

if (globalThis.document) void initializeListingModeration();
