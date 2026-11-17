const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

export async function initializeNotifications({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  const open = document?.getElementById('ruOpenNotifications');
  const panel = document?.getElementById('ruNotifications');
  const status = document?.getElementById('ruNotificationStatus');
  const list = document?.getElementById('ruNotificationList');
  const badge = document?.getElementById('ruNotificationBadge');
  const refreshButton = document?.getElementById('ruNotificationRefresh');
  if (!open || !panel || !status || !list || !badge || !refreshButton || typeof fetchImpl !== 'function') return;

  const request = async (url, init = {}) => {
    const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, ...init });
    return { response, result: await response.json().catch(() => null) };
  };

  async function refresh() {
    status.textContent = 'Загружаем уведомления…';
    list.replaceChildren();
    try {
      const me = await request('/api/v1/me');
      if (me.response.status === 401) {
        status.textContent = 'Войдите через Яндекс ID, чтобы получать уведомления.';
        badge.hidden = true;
        return;
      }
      if (!me.response.ok || !UUID.test(me.result?.profile?.id || '')) throw new Error('profile_unavailable');
      const inbox = await request('/api/v1/messages');
      if (!inbox.response.ok || !Array.isArray(inbox.result?.messages)) throw new Error('messages_unavailable');
      const messages = inbox.result.messages.filter(message => message && UUID.test(message.id || '')
        && UUID.test(message.sender_id || '') && message.receiver_id === me.result.profile.id
        && typeof message.body === 'string')
        .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || '')).slice(0, 50);
      const unread = messages.filter(message => message.is_read !== true).length;
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.hidden = unread === 0;
      if (!messages.length) {
        status.textContent = 'Новых уведомлений нет.';
        return;
      }
      status.textContent = unread ? `Непрочитанных сообщений: ${unread}.` : 'Новых уведомлений нет.';
      for (const message of messages) {
        const item = node(document, 'article', 'ru-message-dialog');
        item.append(node(document, 'strong', '', message.is_read === true ? 'Сообщение' : 'Новое сообщение'));
        item.append(node(document, 'p', 'ru-note', message.body.slice(0, 220)));
        const time = Date.parse(message.created_at || '');
        if (Number.isFinite(time)) item.append(node(document, 'small', 'ru-note', new Date(time).toLocaleString('ru-RU')));
        if (message.is_read !== true) {
          const mark = node(document, 'button', 'ru-button', 'Отметить прочитанным');
          mark.type = 'button';
          mark.addEventListener('click', async () => {
            mark.disabled = true;
            try {
              const result = await request(`/api/v1/messages/${message.id}/read`, { method: 'PATCH' });
              if (!result.response.ok) throw new Error('mark_read_failed');
              await refresh();
            } catch { mark.disabled = false; status.textContent = 'Не удалось сохранить прочтение. Попробуйте ещё раз.'; }
          });
          item.append(mark);
        }
        list.append(item);
      }
    } catch {
      badge.hidden = true;
      status.textContent = 'Не удалось загрузить уведомления. Попробуйте обновить страницу.';
    }
  }

  open.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    open.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) await refresh();
  });
  refreshButton.addEventListener('click', () => { void refresh(); });
  await refresh();
}

if (globalThis.document) void initializeNotifications();
