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
      const [response, eventResponse, profileResponse, roleResponse, suspensionResponse, suspensionTargetsResponse, roleManagementResponse] = await Promise.all([
        fetchImpl('/api/v1/listings/moderation', options),
        fetchImpl('/api/v1/event-registrations/review', options),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/profile-requests/review', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/role-requests/review', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/suspensions', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, suspensions: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/suspensions/targets', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, targets: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/role-management/targets', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, targets: [] }) }),
      ]);
      const [result, eventResult, profileResult, roleResult, suspensionResult, suspensionTargetsResult, roleManagementResult] = await Promise.all([json(response), json(eventResponse), json(profileResponse), json(roleResponse), json(suspensionResponse), json(suspensionTargetsResponse), json(roleManagementResponse)]);
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
      const roleManagementAvailable = me.profile.role !== 'school_admin' || (roleManagementResponse.ok && roleManagementResult?.ok && Array.isArray(roleManagementResult.targets));
      const roleManagementTargets = me.profile.role === 'school_admin' && roleManagementAvailable
        ? roleManagementResult.targets.filter(item => item && UUID.test(item.id) && ['council_member', 'school_admin'].includes(item.role)) : [];
      const suspensionsAvailable = me.profile.role !== 'school_admin'
        || (suspensionResponse.ok && suspensionResult?.ok && Array.isArray(suspensionResult.suspensions));
      const suspensions = me.profile.role === 'school_admin' && suspensionsAvailable
        ? suspensionResult.suspensions.filter(item => item && UUID.test(item.target_id)
          && ['student', 'council_member'].includes(item.target_role) && typeof item.reason === 'string'
          && typeof item.expires_at === 'string') : [];
      if (me.profile.role === 'school_admin' && suspensionTargetsResponse.ok && suspensionTargetsResult?.ok && Array.isArray(suspensionTargetsResult.targets)) {
        const targets = suspensionTargetsResult.targets.filter(item => item && UUID.test(item.id) && ['student', 'council_member'].includes(item.role));
        if (targets.length) {
          const panel = node(document, 'section', 'ru-moderation-card');
          panel.append(node(document, 'h3', '', 'Временное ограничение действий аккаунта'));
          const note = node(document, 'p', '', 'Доступно администраторам этой школы после повторного подтверждения входа. Выберите срок и укажите фактическую причину без личных данных.');
          const form = document.createElement('form'); form.className = 'ru-suspension-form';
          const select = document.createElement('select'); select.required = true; select.setAttribute('aria-label', 'Аккаунт');
          const prompt = node(document, 'option', '', 'Выберите аккаунт'); prompt.value = ''; prompt.disabled = true; prompt.selected = true; select.append(prompt);
          for (const target of targets) {
            const name = [target.first_name, target.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
            const option = node(document, 'option', '', `${name || 'Ученик'} · ${target.role === 'student' ? 'ученик' : 'Совет'}`);
            option.value = target.id; select.append(option);
          }
          const duration = document.createElement('select'); duration.required = true; duration.setAttribute('aria-label', 'Срок ограничения');
          for (const [hours, label] of [[24, '24 часа'], [72, '3 дня'], [168, '7 дней']]) { const option = node(document, 'option', '', label); option.value = String(hours); duration.append(option); }
          const reason = document.createElement('textarea'); reason.required = true; reason.minLength = 15; reason.maxLength = 400; reason.placeholder = 'Причина (15–400 символов, без контактов)';
          const issueSuspension = async () => {
            if (!UUID.test(select.value || '') || reason.value.trim().length < 15 || reason.value.trim().length > 400) { status.textContent = 'Выберите аккаунт и укажите причину длиной 15–400 символов.'; return; }
            await patch(`/api/v1/suspensions/${select.value}`, { action: 'issue', duration_hours: Number(duration.value), reason: reason.value.trim() });
          };
          const submit = actionButton(document, 'Установить ограничение', issueSuspension);
          form.addEventListener('submit', async event => { event.preventDefault(); await issueSuspension(); });
          form.append(select, duration, reason, submit); panel.append(note, form); queue.append(panel);
        }
      }
      if (me.profile.role === 'school_admin' && roleManagementTargets.length) {
        const panel = node(document, 'section', 'ru-moderation-card');
        panel.append(node(document, 'h3', '', 'Управление полномочиями школы'));
        panel.append(node(document, 'p', '', 'После подтверждения полномочий аккаунт останется активным.'));
        for (const target of roleManagementTargets) {
          const row = node(document, 'div', 'ru-moderation-actions');
          const name = [target.first_name, target.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
          row.append(node(document, 'span', '', `${name || 'Пользователь'} · ${target.role === 'school_admin' ? 'администратор школы' : 'участник Совета'}${target.class_name ? ` · ${target.class_name}` : ''}`));
          row.append(actionButton(document, 'Снять роль', async () => {
            const confirmAction = document.defaultView?.confirm || globalThis.confirm;
            if (!confirmAction || !confirmAction(`Снять роль у ${name || 'пользователя'}? Аккаунт останется активным.`)) return;
            await patch(`/api/v1/role-management/${target.id}`, { action: 'revoke' });
          }));
          panel.append(row);
        }
        queue.append(panel);
      }
      if (result.listings.length === 0 && applications.length === 0 && profileRequests.length === 0 && roleRequests.length === 0 && suspensions.length === 0 && roleManagementTargets.length === 0) {
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
        const lift = actionButton(document, 'Снять ограничение', () => patch(`/api/v1/suspensions/${suspension.target_id}`, { action: 'lift' }));
        card.append(lift);
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
      const result = await json(response);
      if (!response.ok) {
        if (result?.error === 'fresh_auth_required') {
          status.replaceChildren(node(document, 'span', '', 'Для этого действия повторно войдите через Яндекс ID. '));
          const link = node(document, 'a', '', 'Подтвердить вход'); link.href = '/auth/yandex/start?reauth=1';
          status.append(link);
          return;
        }
        if (result?.error === 'already_suspended') { status.textContent = 'У этого аккаунта уже есть действующее ограничение.'; return; }
        throw new Error('decision_failed');
      }
      status.textContent = body.action === 'issue' ? 'Временное ограничение установлено.'
        : body.action === 'revoke' ? 'Полномочия сняты. Аккаунт остался активным.'
          : 'Временное ограничение снято.';
      await load();
    } catch { status.textContent = 'Не удалось сохранить решение. Очередь не обновлена.'; }
  }

  await load();
  await loadDeletionRequests();

  async function loadDeletionRequests() {
    if (me.profile.role === 'council_member') {
      const section = document.getElementById('ruDeletionRequestSubmit');
      const targetsSelect = document.getElementById('ruDeletionTarget');
      const reasonCode = document.getElementById('ruDeletionReasonCode');
      const reason = document.getElementById('ruDeletionReason');
      const form = document.getElementById('ruDeletionRequestForm');
      const requestStatus = document.getElementById('ruDeletionRequestStatus');
      const ownRequests = document.getElementById('ruDeletionOwnRequests');
      if (!section || !targetsSelect || !reasonCode || !reason || !form || !requestStatus || !ownRequests) return;
      section.hidden = false;
      try {
        const options = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
        const [targetResponse, ownResponse] = await Promise.all([
          fetchImpl('/api/v1/deletion-requests/targets', options),
          fetchImpl('/api/v1/deletion-requests', options),
        ]);
        const [targetResult, ownResult] = await Promise.all([json(targetResponse), json(ownResponse)]);
        if (!targetResponse.ok || !targetResult?.ok || !Array.isArray(targetResult.targets)
          || !ownResponse.ok || !ownResult?.ok || !Array.isArray(ownResult.requests)) throw new Error('deletion_requests_unavailable');
        targetsSelect.replaceChildren();
        const prompt = node(document, 'option', '', 'Выберите аккаунт'); prompt.value = ''; prompt.disabled = true; prompt.selected = true;
        targetsSelect.append(prompt);
        for (const target of targetResult.targets) {
          if (!target || !UUID.test(target.id) || !['student', 'council_member'].includes(target.role)) continue;
          const label = [target.first_name, target.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
          const option = node(document, 'option', '', `${label || 'Ученик'} · ${target.role === 'student' ? 'ученик' : 'Совет'}`);
          option.value = target.id;
          targetsSelect.append(option);
        }
        renderOwnDeletionRequests(document, ownRequests, ownResult.requests);
        requestStatus.textContent = targetResult.targets.length ? '' : 'В школе нет доступных аккаунтов для обращения.';
      } catch {
        requestStatus.textContent = 'Не удалось загрузить список аккаунтов и обращений. Попробуйте позже.';
      }
      if (!form.dataset?.bound) {
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (!UUID.test(targetsSelect.value || '') || reason.value.trim().length < 15 || reason.value.trim().length > 500) {
            requestStatus.textContent = 'Выберите аккаунт и укажите объяснение длиной 15–500 символов.';
            return;
          }
          requestStatus.textContent = 'Отправляем обращение…';
          try {
            const response = await fetchImpl('/api/v1/deletion-requests', {
              method: 'POST', credentials: 'same-origin', cache: 'no-store',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ target_id: targetsSelect.value, reason_code: reasonCode.value, reason: reason.value.trim() }),
            });
            const result = await json(response);
            if (!response.ok || !result?.ok) throw new Error('request_failed');
            requestStatus.textContent = result.already_exists
              ? 'По этому аккаунту уже есть открытое обращение.'
              : 'Обращение передано администратору школы. Аккаунт не удалён.';
            if (!result.already_exists) reason.value = '';
            const historyResponse = await fetchImpl('/api/v1/deletion-requests', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
            const history = await json(historyResponse);
            if (historyResponse.ok && history?.ok && Array.isArray(history.requests)) renderOwnDeletionRequests(document, ownRequests, history.requests);
          } catch { requestStatus.textContent = 'Не удалось отправить обращение. Повторите попытку позже.'; }
        });
        if (form.dataset) form.dataset.bound = 'true';
      }
      return;
    }

    if (me.profile.role !== 'school_admin') return;
    const section = document.getElementById('ruDeletionRequestReview');
    const requestStatus = document.getElementById('ruDeletionReviewStatus');
    const reviewQueue = document.getElementById('ruDeletionReviewQueue');
    if (!section || !requestStatus || !reviewQueue) return;
    section.hidden = false;
    try {
      const response = await fetchImpl('/api/v1/deletion-requests/review', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      const result = await json(response);
      if (!response.ok || !result?.ok || !Array.isArray(result.requests)) throw new Error('deletion_review_unavailable');
      reviewQueue.replaceChildren();
      const requests = result.requests.filter(item => item && UUID.test(item.request_id)
        && ['student', 'council_member'].includes(item.target_role) && typeof item.reason === 'string'
        && ['rules_violation', 'harassment', 'fake_account', 'spam', 'other'].includes(item.reason_code));
      requestStatus.textContent = requests.length ? `Открытых обращений: ${requests.length}.` : 'Открытых обращений нет.';
      for (const item of requests) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', 'Обращение по аккаунту'));
        card.append(node(document, 'p', '', `ID аккаунта: ${item.target_id}`));
        card.append(node(document, 'p', '', `Причина: ${item.reason}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        actions.append(actionButton(document, 'Отклонить обращение', async () => {
          requestStatus.textContent = 'Закрываем обращение…';
          try {
            const decision = await fetchImpl(`/api/v1/deletion-requests/${item.request_id}`, {
              method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ decision: 'reject' }),
            });
            if (!decision.ok) throw new Error('decision_failed');
            await loadDeletionRequests();
          } catch { requestStatus.textContent = 'Не удалось отклонить обращение. Очередь не обновлена.'; }
        }));
        card.append(actions); reviewQueue.append(card);
      }
    } catch { requestStatus.textContent = 'Не удалось загрузить обращения этой школы.'; }
  }
}

function renderOwnDeletionRequests(document, container, requests) {
  container.replaceChildren();
  if (!requests.length) { container.append(node(document, 'p', 'ru-note', 'Обращений пока нет.')); return; }
  for (const request of requests.slice(0, 10)) {
    if (!request || !UUID.test(request.request_id) || typeof request.status !== 'string' || typeof request.reason !== 'string') continue;
    const card = node(document, 'article', 'ru-moderation-card');
    const status = request.status === 'pending' ? 'ожидает рассмотрения' : request.status === 'rejected' ? 'отклонено' : request.status;
    card.append(node(document, 'p', '', `Обращение: ${status}`));
    card.append(node(document, 'p', '', request.reason));
    if (request.review_note) card.append(node(document, 'p', 'ru-note', `Комментарий: ${request.review_note}`));
    container.append(card);
  }
}

function actionButton(document, label, handler) {
  const button = node(document, 'button', 'ru-button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

if (globalThis.document) void initializeListingModeration();
