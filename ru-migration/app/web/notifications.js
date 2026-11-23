const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASES = Object.freeze([
  { id: 'release:fam-ru-copy-2026-11', title: 'Российская версия FAM', text: 'Основные школьные сценарии перенесены в отдельную российскую копию.', time: Date.parse('2026-11-17T00:00:00Z') },
  { id: 'release:fam-ru-private-media-2026-11', title: 'Российская версия FAM', text: 'Фото школьных идей, объявлений и профилей проходят ручную проверку сотрудниками своей школы.', time: Date.parse('2026-11-17T00:00:00Z') },
]);

function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

export async function initializeNotifications({ document = globalThis.document, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let open = document?.getElementById('ruOpenNotifications');
  let panel = document?.getElementById('ruNotifications');
  let status = document?.getElementById('ruNotificationStatus');
  let list = document?.getElementById('ruNotificationList');
  let badge = document?.getElementById('ruNotificationBadge');
  let refreshButton = document?.getElementById('ruNotificationRefresh');
  let clearButton = document?.getElementById('ruNotificationClear');
  if (!open || !panel || !status || !list || !badge || !refreshButton) {
    const messagesButton = document?.getElementById('ruOpenMessages');
    const shell = messagesButton?.parentElement;
    if (!shell) return;
    open = node(document, 'button', 'ru-button', 'Уведомления');
    open.id = 'ruOpenNotifications'; open.type = 'button'; open.setAttribute('aria-expanded', 'false');
    panel = node(document, 'section', 'ru-messages'); panel.id = 'ruNotifications'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Уведомления');
    badge = node(document, 'span', '', ''); badge.id = 'ruNotificationBadge'; badge.hidden = true; open.append(badge);
    const heading = node(document, 'div', 'ru-messages-heading'); heading.append(node(document, 'h2', '', 'Уведомления'));
    refreshButton = node(document, 'button', 'ru-button', 'Обновить'); refreshButton.id = 'ruNotificationRefresh'; refreshButton.type = 'button';
    clearButton = node(document, 'button', 'ru-button', 'Убрать все'); clearButton.id = 'ruNotificationClear'; clearButton.type = 'button';
    heading.append(refreshButton, clearButton);
    status = node(document, 'p', 'ru-note', ''); status.id = 'ruNotificationStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    list = node(document, 'div', 'ru-message-list'); list.id = 'ruNotificationList'; list.setAttribute('aria-live', 'polite');
    panel.append(heading, status, list);
    if (typeof messagesButton.before === 'function') messagesButton.before(open, panel); else shell.append(open, panel);
  }
  if (!open || !panel || !status || !list || !badge || !refreshButton || typeof fetchImpl !== 'function') return;

  const request = async (url, init = {}) => {
    const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, ...init });
    return { response, result: await response.json().catch(() => null) };
  };
  let feed = [];
  let sequence = 0;

  function render() {
    const unread = feed.filter(item => item.isRead !== true).length;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.hidden = unread === 0;
    list.replaceChildren();
    for (const notification of feed) {
      const item = node(document, 'article', `ru-message-dialog${notification.isRead ? ' is-read' : ''}`);
      item.append(node(document, 'strong', '', notification.title));
      item.append(node(document, 'p', 'ru-note', notification.text));
      if (Number.isFinite(notification.time)) item.append(node(document, 'small', 'ru-note', new Date(notification.time).toLocaleString('ru-RU')));
      const actions = node(document, 'div', 'ru-notification-actions');
      if (!notification.isRead) {
        const mark = node(document, 'button', 'ru-button', 'Отметить прочитанным'); mark.type = 'button';
        mark.addEventListener('click', () => { void markRead([notification]); }); actions.append(mark);
      } else actions.append(node(document, 'span', 'ru-note', '✓ Прочитано'));
      const dismiss = node(document, 'button', 'ru-button', 'Убрать'); dismiss.type = 'button';
      dismiss.addEventListener('click', () => { void dismissNotification(notification); }); actions.append(dismiss);
      item.append(actions); list.append(item);
    }
    if (!feed.length) status.textContent = 'Уведомлений пока нет. Новые события появятся здесь.';
    else if (unread) status.textContent = `Непрочитанных уведомлений: ${unread}.`;
    else status.textContent = 'Новых уведомлений нет.';
  }

  async function saveKeys(keys) {
    if (!keys.length) return;
    const result = await request('/api/v1/notification-reads', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ notification_keys: [...new Set(keys)] }),
    });
    if (!result.response.ok || result.result?.ok !== true) throw new Error('notification_state_save_failed');
  }

  async function markRead(items) {
    const selected = items.filter(item => !item.isRead);
    if (!selected.length) return true;
    try {
      const messageIds = selected.filter(item => item.kind === 'message' && item.recordId).map(item => item.recordId);
      if (messageIds.length) {
        const read = await request('/api/v1/messages/read', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ message_ids: [...new Set(messageIds)] }) });
        if (!read.response.ok || read.result?.ok !== true) throw new Error('message_read_failed');
      }
      await saveKeys(selected.map(item => item.id));
      selected.forEach(item => { item.isRead = true; });
      render();
      return true;
    } catch {
      status.textContent = 'Не удалось сохранить прочтение. Попробуйте ещё раз.';
      return false;
    }
  }

  async function dismissNotification(notification) {
    try {
      if (notification.kind === 'message' && notification.recordId && !notification.isRead) {
        const read = await request(`/api/v1/messages/${notification.recordId}/read`, { method: 'PATCH' });
        if (!read.response.ok) throw new Error('message_read_failed');
      }
      await saveKeys([`dismissed:${notification.id}`]);
      feed = feed.filter(item => item.id !== notification.id);
      render();
    } catch { status.textContent = 'Не удалось убрать уведомление. Попробуйте ещё раз.'; }
  }

  const optional = async (url, key) => {
    try {
      const result = await request(url);
      return result.response.ok ? result.result?.[key] : null;
    } catch { return null; }
  };

  async function refresh({ markOnOpen = false } = {}) {
    const refreshId = ++sequence;
    status.textContent = 'Загружаем уведомления…'; list.replaceChildren();
    try {
      const me = await request('/api/v1/me');
      if (me.response.status === 401) { feed = []; badge.hidden = true; status.textContent = 'Войдите через Яндекс ID, чтобы получать уведомления.'; return; }
      const profile = me.result?.profile;
      if (!me.response.ok || !UUID.test(profile?.id || '')) throw new Error('profile_unavailable');
      const daysAgo = now() - 14 * 24 * 60 * 60 * 1000;
      const role = profile.role;
      const [inbox, listings, ideas, eventReviews, roleRequests, roleReview, deletionRequests, myDeletionRequests] = await Promise.all([
        request('/api/v1/messages'), optional('/api/v1/notifications/listings', 'listings'),
        ['school_admin', 'council_member'].includes(role) ? optional('/api/v1/school/ideas', 'ideas') : Promise.resolve(null),
        ['school_admin', 'council_member'].includes(role) ? optional('/api/v1/event-registrations/review', 'applications') : Promise.resolve(null),
        role === 'student' ? optional('/api/v1/role-requests', 'request') : Promise.resolve(null),
        role === 'school_admin' ? optional('/api/v1/role-requests/review', 'requests') : Promise.resolve(null),
        role === 'school_admin' ? optional('/api/v1/deletion-requests/review', 'requests') : Promise.resolve(null),
        role === 'council_member' ? optional('/api/v1/deletion-requests', 'requests') : Promise.resolve(null),
      ]);
      if (refreshId !== sequence) return;
      if (!inbox.response.ok || !Array.isArray(inbox.result?.messages)) throw new Error('messages_unavailable');
      const items = RELEASES.map(item => ({ ...item, kind: 'release' }));
      const add = item => { if (item && typeof item.id === 'string' && item.id.length <= 210) items.push(item); };
      if (Array.isArray(listings)) listings.filter(row => row && typeof row.id === 'string'
        && Number.isFinite(Date.parse(row.created_at || '')) && Date.parse(row.created_at) >= daysAgo)
        .slice(0, 8).forEach(row => add({ id: `school-listing:${row.id}`, kind: 'listing',
          title: row.is_event ? 'Новое мероприятие школы' : 'Новое объявление школы',
          text: row.title || 'Опубликован новый материал', time: Date.parse(row.created_at) }));
      if (Array.isArray(ideas)) ideas.filter(row => row?.ai_status === 'approved'
        && Number.isFinite(Date.parse(row.created_at || '')) && Date.parse(row.created_at) >= daysAgo)
        .slice(0, 8).forEach(row => add({ id: `school-idea:${row.id}`, kind: 'idea', title: 'Новая идея ученика',
          text: String(row.text || 'Предложена новая идея').slice(0, 110), time: Date.parse(row.created_at) }));
      inbox.result.messages.filter(message => message && UUID.test(message.id || '') && UUID.test(message.sender_id || '')
        && message.receiver_id === profile.id && typeof message.body === 'string')
        .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || '')).slice(0, 50)
        .forEach(message => add({ id: `message:${message.id}`, recordId: message.id, kind: 'message', is_read: message.is_read === true,
          title: message.is_read ? 'Сообщение' : 'Новое сообщение', text: message.body.slice(0, 100),
          time: Date.parse(message.created_at || '') }));
      if (Array.isArray(eventReviews)) eventReviews.slice(0, 20).forEach(row => add({
        id: `event-registration:${row.event_id}:${row.user_id}`, kind: 'registration', title: 'Заявка на мероприятие',
        text: row.event_title ? `Новая заявка на «${row.event_title}»` : 'Появилась новая заявка на ваше мероприятие',
        time: Date.parse(row.created_at || '') }));
      if (Array.isArray(roleReview)) roleReview.filter(row => ['pending', 'reviewing'].includes(row.status)).slice(0, 20).forEach(row => add({
        id: `school-access-request:${row.request_id || row.id}`, kind: 'access-request', title: 'Заявка на роль в школе',
        text: 'Новая заявка ожидает решения администратора школы.', time: Date.parse(row.created_at || '') }));
      if (roleRequests && ['approved', 'rejected'].includes(roleRequests.status)
          && Date.parse(roleRequests.reviewed_at || roleRequests.created_at || '') >= daysAgo) add({
        id: `school-access-result:${roleRequests.request_id || roleRequests.id}:${roleRequests.status}`, kind: 'access-result',
        title: roleRequests.status === 'approved' ? 'Заявка одобрена' : 'Заявка рассмотрена',
        text: roleRequests.status === 'approved' ? 'Ваша заявка на роль в школе одобрена.' : 'Ваша заявка рассмотрена.',
        time: Date.parse(roleRequests.reviewed_at || roleRequests.created_at || '') });
      if (Array.isArray(deletionRequests)) deletionRequests.slice(0, 20).forEach(row => add({
        id: `account-deletion-request:${row.request_id || row.id}`, kind: 'deletion-request', title: 'Запрос на проверку аккаунта',
        text: `Запрос ожидает решения · ${String(row.reason_code || 'прочая причина').slice(0, 80)}`,
        time: Date.parse(row.created_at || '') }));
      if (Array.isArray(myDeletionRequests)) myDeletionRequests
        .filter(row => row && typeof row.request_id === 'string' && UUID.test(row.request_id)
          && ['approved', 'rejected'].includes(row.status)
          && Number.isFinite(Date.parse(row.reviewed_at || row.created_at || ''))
          && Date.parse(row.reviewed_at || row.created_at || '') >= daysAgo)
        .slice(0, 10).forEach(row => {
          const approved = row.status === 'approved';
          add({ id: `account-deletion-result:${row.request_id}:${row.status}`, kind: 'deletion-result',
            title: approved ? 'Запрос Совета одобрен' : 'Запрос Совета отклонён',
            text: approved ? 'Администратор школы одобрил запрос на удаление аккаунта.'
              : typeof row.review_note === 'string' && row.review_note.trim()
                ? `Администратор отклонил запрос: ${row.review_note.trim().slice(0, 180)}`
                : 'Администратор школы отклонил запрос на удаление аккаунта.',
            time: Date.parse(row.reviewed_at || row.created_at || '') });
        });

      const ordered = items.sort((a, b) => (Number.isFinite(b.time) ? b.time : 0) - (Number.isFinite(a.time) ? a.time : 0)).slice(0, 60);
      const states = await request('/api/v1/notification-reads');
      if (!states.response.ok || !Array.isArray(states.result?.notification_keys) || states.result.notification_keys.length > 10_000) {
        throw new Error('notification_state_incomplete');
      }
      if (refreshId !== sequence) return;
      const readKeys = new Set(states.result.notification_keys.filter(key => typeof key === 'string'));
      const dismissed = new Set([...readKeys].filter(key => key.startsWith('dismissed:')).map(key => key.slice(10)));
      feed = ordered.filter(item => !dismissed.has(item.id)).map(item => ({ ...item,
        isRead: item.kind === 'message' && item.is_read === true || readKeys.has(item.id) }));
      render();
      if (markOnOpen) await markRead(feed.filter(item => !item.isRead));
    } catch {
      if (refreshId !== sequence) return;
      badge.hidden = true;
      status.textContent = 'Не удалось загрузить уведомления. Попробуйте обновить страницу.';
    }
  }

  open.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    open.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) await refresh({ markOnOpen: true });
  });
  refreshButton.addEventListener('click', () => { void refresh(); });
  clearButton?.addEventListener('click', async () => {
    try { await saveKeys(feed.map(item => `dismissed:${item.id}`)); feed = []; render(); }
    catch { status.textContent = 'Не удалось убрать уведомления. Попробуйте ещё раз.'; }
  });
  await refresh();
}

if (globalThis.document) void initializeNotifications();
