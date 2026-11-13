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
      const [response, eventResponse, profileResponse, roleResponse, suspensionResponse] = await Promise.all([
        fetchImpl('/api/v1/listings/moderation', options),
        fetchImpl('/api/v1/event-registrations/review', options),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/profile-requests/review', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/role-requests/review', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/suspensions', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, suspensions: [] }) }),
      ]);
      const [result, eventResult, profileResult, roleResult, suspensionResult] = await Promise.all([json(response), json(eventResponse), json(profileResponse), json(roleResponse), json(suspensionResponse)]);
      if (!response.ok || !result?.ok || !Array.isArray(result.listings)
        || !eventResponse.ok || !eventResult?.ok || !Array.isArray(eventResult.applications)
        || !profileResponse.ok || !profileResult?.ok || !Array.isArray(profileResult.requests)
        || !roleResponse.ok || !roleResult?.ok || !Array.isArray(roleResult.requests)) throw new Error('queue_unavailable');
      queue.replaceChildren();
      const applications = eventResult.applications.filter(application => application
        && UUID.test(application.event_id) && UUID.test(application.user_id)
        && application.status === 'pending' && typeof application.event_title === 'string');
      const profileRequests = profileResult.requests.filter(request => request && UUID.test(request.request_id)
        && typeof request.first_name === 'string' && typeof request.last_name === 'string'
        && typeof request.class_name === 'string');
      const roleRequests = roleResult.requests.filter(request => request && UUID.test(request.request_id)
        && ['council_member', 'school_admin'].includes(request.requested_role)
        && ['pending', 'reviewing'].includes(request.status));
      const suspensionsAvailable = me.profile.role !== 'school_admin'
        || (suspensionResponse.ok && suspensionResult?.ok && Array.isArray(suspensionResult.suspensions));
      const suspensions = me.profile.role === 'school_admin' && suspensionsAvailable
        ? suspensionResult.suspensions.filter(item => item && UUID.test(item.target_id)
          && ['student', 'council_member'].includes(item.target_role) && typeof item.reason === 'string'
          && typeof item.expires_at === 'string') : [];
      if (result.listings.length === 0 && applications.length === 0 && profileRequests.length === 0 && roleRequests.length === 0 && suspensions.length === 0) {
        status.textContent = suspensionsAvailable ? 'Очереди школьной проверки пусты.'
          : 'Очереди проверки пусты, но не удалось загрузить действующие ограничения. Обновите список позже.';
        return;
      }
      status.textContent = `Очереди: объявлений — ${result.listings.length}, заявок на мероприятия — ${applications.length}, школьных профилей — ${profileRequests.length}, запросов ролей — ${roleRequests.length}, действующих ограничений — ${suspensions.length}.${suspensionsAvailable ? '' : ' Не удалось загрузить ограничения; список неполный.'}`;
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
      for (const request of profileRequests) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', `${request.first_name} ${request.last_name}`));
        card.append(node(document, 'p', '', `Заявка на ученический профиль · ${request.class_name}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        const path = `/api/v1/profile-requests/${request.request_id}`;
        actions.append(actionButton(document, 'Одобрить ученика', () => decide(path, 'approve')));
        actions.append(actionButton(document, 'Отклонить заявку', () => decide(path, 'reject')));
        card.append(actions); queue.append(card);
      }
      for (const request of roleRequests) {
        const card = node(document, 'article', 'ru-moderation-card');
        const roleName = request.requested_role === 'school_admin' ? 'Администратор школы' : 'Участник Ученического совета';
        card.append(node(document, 'h3', '', `Запрос: ${roleName}`));
        card.append(node(document, 'p', '', request.status === 'reviewing' ? 'Взято на рассмотрение' : 'Ожидает рассмотрения'));
        const actions = node(document, 'div', 'ru-moderation-actions');
        const path = `/api/v1/role-requests/${request.request_id}`;
        if (request.status === 'pending') actions.append(actionButton(document, 'Начать рассмотрение', () => patch(path, { action: 'start_review' })));
        if (request.status === 'reviewing' && request.review_started_by === me.profile.id) {
          actions.append(actionButton(document, 'Одобрить роль', () => patch(path, { decision: 'approve' })));
          actions.append(actionButton(document, 'Отклонить', () => patch(path, { decision: 'reject' })));
        }
        card.append(actions); queue.append(card);
      }
      for (const suspension of suspensions) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', 'Временное ограничение аккаунта'));
        card.append(node(document, 'p', '', `ID аккаунта: ${suspension.target_id}`));
        card.append(node(document, 'p', '', `Причина: ${suspension.reason}`));
        card.append(node(document, 'p', '', `Действует до: ${new Date(suspension.expires_at).toLocaleString('ru-RU')}`));
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

  async function patch(path, body) {
    status.textContent = 'Сохраняем решение…';
    try {
      const response = await fetchImpl(path, { method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
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
