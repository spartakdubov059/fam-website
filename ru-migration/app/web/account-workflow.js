const CONFIRMATION = 'УДАЛИТЬ МОЙ АККАУНТ';

function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

async function json(response) {
  try { return await response.json(); } catch { return null; }
}

export async function initializeAccountWorkflow({ document = globalThis.document, fetchImpl = globalThis.fetch,
  location = globalThis.location } = {}) {
  if (!document || typeof fetchImpl !== 'function') return;
  const section = document.getElementById('ruAccountWorkflow');
  if (!section) return;

  let profile;
  try {
    const response = await fetchImpl('/api/v1/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    const result = await json(response);
    if (!response.ok || !result?.ok || !result.profile?.id) return;
    profile = result.profile;
  } catch { return; }

  section.hidden = false;
  section.append(node(document, 'h2', '', 'Удаление аккаунта'));
  section.append(node(document, 'p', 'ru-note', 'Удалятся профиль, ваши объявления, идеи, избранное, сообщения, записи на события и принадлежащие аккаунту фотографии. Действие необратимо. Последнего администратора школы удалить нельзя.'));
  const status = node(document, 'p', 'ru-note', 'Для удаления потребуется повторный вход через Яндекс ID и точное подтверждение.');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  section.append(status);
  const button = node(document, 'button', 'ru-button ru-account-delete-button', 'Удалить мой аккаунт');
  button.type = 'button'; section.append(button);

  button.addEventListener('click', async () => {
    const confirmAction = document.defaultView?.confirm || globalThis.confirm;
    const promptAction = document.defaultView?.prompt || globalThis.prompt;
    if (typeof confirmAction !== 'function' || typeof promptAction !== 'function') {
      status.textContent = 'Браузер не поддерживает подтверждение удаления. Аккаунт не изменён.';
      return;
    }
    if (!confirmAction('Удалить аккаунт FAM и перечисленные выше данные без возможности восстановления?')) return;
    if (promptAction('Для продолжения введите точно: УДАЛИТЬ МОЙ АККАУНТ') !== CONFIRMATION) {
      status.textContent = 'Фраза не совпала. Аккаунт не изменён.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Проверяем свежесть входа и удаляем данные аккаунта…';
    try {
      const response = await fetchImpl('/api/v1/me/account', {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ confirmation: CONFIRMATION }),
      });
      const result = await json(response);
      if (!response.ok || !result?.ok || !result.deleted) {
        if (result?.error === 'recent_yandex_login_required') {
          status.textContent = 'Для удаления войдите через Яндекс ID повторно. Аккаунт не изменён.';
          return;
        }
        if (result?.error === 'last_school_admin') {
          status.textContent = 'Это последний администратор школы. Сначала назначьте другого администратора.';
          return;
        }
        throw new Error('account_delete_failed');
      }
      section.replaceChildren(node(document, 'h2', '', 'Аккаунт удалён'));
      const done = node(document, 'p', 'ru-note', 'Данные и приватные файлы аккаунта удалены. Завершаем сеанс…');
      done.setAttribute('role', 'status'); done.setAttribute('aria-live', 'polite'); section.append(done);
      try {
        const logout = await fetchImpl('/auth/yandex/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        if (logout.ok) location?.reload?.();
        else done.textContent = 'Аккаунт удалён. Не удалось завершить сеанс; закройте эту страницу.';
      } catch { done.textContent = 'Аккаунт удалён. Не удалось завершить сеанс; закройте эту страницу.'; }
    } catch {
      status.textContent = 'Не удалось завершить удаление. Проверьте подключение; повторите попытку только после проверки статуса аккаунта.';
    } finally { button.disabled = false; }
  });

  return profile;
}

if (globalThis.document) void initializeAccountWorkflow();
