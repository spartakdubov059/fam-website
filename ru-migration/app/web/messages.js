const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function node(document, tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export async function initializeMessages({ document = globalThis.document, fetchImpl = globalThis.fetch, location = globalThis.location } = {}) {
  const open = document?.getElementById('ruOpenMessages');
  const panel = document?.getElementById('ruMessages');
  const status = document?.getElementById('ruMessagesStatus');
  const list = document?.getElementById('ruMessageList');
  const form = document?.getElementById('ruMessageForm');
  const back = document?.getElementById('ruMessagesBack');
  if (!open || !panel || !status || !list || !form || !back || typeof fetchImpl !== 'function') return;

  let currentUser = null;
  let currentPeer = null;
  let messages = [];
  let busy = false;
  const json = async (url, init) => {
    const response = await fetchImpl(url, init);
    return { response, result: await response.json().catch(() => null) };
  };

  function showThreads() {
    currentPeer = null;
    back.hidden = true;
    form.hidden = true;
    list.replaceChildren();
    const peers = new Map();
    for (const message of messages) {
      const peer = message.sender_id === currentUser ? message.receiver_id : message.sender_id;
      if (!UUID.test(peer || '')) continue;
      if (!peers.has(peer)) peers.set(peer, message);
    }
    if (!peers.size) {
      list.append(node(document, 'p', 'ru-messages-status', 'Пока нет диалогов. Напишите автору объявления на доске.'));
      return;
    }
    for (const [peer, latest] of peers) {
      const button = node(document, 'button', 'ru-message-dialog', `Диалог · ${latest.body || 'Сообщение'}${latest.is_read === false && latest.receiver_id === currentUser ? ' · новое' : ''}`);
      button.type = 'button';
      button.addEventListener('click', () => showConversation(peer));
      list.append(button);
    }
  }

  async function refresh() {
    try {
      const me = await json('/api/v1/me', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (me.response.status === 401) { currentUser = null; status.textContent = 'Войдите через Яндекс ID, чтобы читать сообщения.'; return false; }
      if (!me.response.ok || !UUID.test(me.result?.profile?.id || '')) throw new Error('profile_unavailable');
      currentUser = me.result.profile.id;
      const inbox = await json('/api/v1/messages', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!inbox.response.ok || !Array.isArray(inbox.result?.messages)) throw new Error('messages_unavailable');
      messages = inbox.result.messages.filter(item => item && UUID.test(item.id || '')
        && UUID.test(item.sender_id || '') && UUID.test(item.receiver_id || '') && typeof item.body === 'string');
      status.textContent = '';
      return true;
    } catch {
      status.textContent = 'Не удалось загрузить сообщения. Попробуйте позже.';
      return false;
    }
  }

  async function showConversation(peer) {
    if (!UUID.test(peer || '') || peer === currentUser) return;
    currentPeer = peer;
    back.hidden = false;
    form.hidden = false;
    list.replaceChildren();
    const conversation = messages.filter(item => (item.sender_id === currentUser && item.receiver_id === peer)
      || (item.sender_id === peer && item.receiver_id === currentUser))
      .sort((a, b) => Date.parse(a.created_at || '') - Date.parse(b.created_at || '')).slice(-100);
    for (const message of conversation) {
      const bubble = node(document, 'div', 'ru-message-bubble', message.body);
      bubble.dataset.own = String(message.sender_id === currentUser);
      list.append(bubble);
      if (message.receiver_id === currentUser && message.is_read !== true) {
        void fetchImpl(`/api/v1/messages/${message.id}/read`, { method: 'PATCH', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      }
    }
    if (!conversation.length) list.append(node(document, 'p', 'ru-messages-status', 'История пуста. Напишите первое сообщение.'));
    status.textContent = 'Диалог защищён школьными ограничениями доступа; отправка проходит проверку безопасности.';
  }

  open.addEventListener('click', async () => {
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    if (await refresh()) showThreads();
    else if (status.textContent.startsWith('Войдите')) {
      const link = document.createElement('a'); link.className = 'ru-auth-link'; link.href = '/auth/yandex/start'; link.textContent = 'Войти через Яндекс ID'; list.replaceChildren(link);
    }
  });
  back.addEventListener('click', () => showThreads());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !currentPeer || !currentUser) return;
    const input = form.elements.namedItem('body');
    const body = String(input?.value || '').trim();
    if (!body || body.length > 1000) return;
    busy = true;
    const button = form.querySelector('button[type="submit"]'); if (button) button.disabled = true;
    try {
      const sent = await json('/api/v1/messages', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ receiver_id: currentPeer, body }) });
      if (!sent.response.ok || !sent.result?.ok) {
        status.textContent = sent.result?.status === 'pending' ? 'Сообщение не отправлено: проверка безопасности недоступна.' : 'Не удалось отправить сообщение. Попробуйте позже.';
        return;
      }
      input.value = '';
      if (await refresh()) await showConversation(currentPeer);
    } catch { status.textContent = 'Нет связи с сервером. Попробуйте ещё раз.'; }
    finally { busy = false; if (button) button.disabled = false; }
  });
}

if (globalThis.document) void initializeMessages();
