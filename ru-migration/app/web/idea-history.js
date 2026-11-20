const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
async function readJson(response) { try { return await response.json(); } catch { return null; } }

export async function initializeIdeaHistory({ document = globalThis.document, fetchImpl = globalThis.fetch,
  confirmImpl = message => typeof globalThis.confirm === 'function' && globalThis.confirm(message) } = {}) {
  const root = document?.getElementById?.('ruIdeaHistory');
  if (!root || typeof fetchImpl !== 'function') return;
  root.hidden = true;
  const heading = node(document, 'h2', '', 'Мои идеи');
  const status = node(document, 'p', 'ru-note', 'Загружаем историю идей…');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = node(document, 'div', 'ru-idea-history-list');
  const clearAll = node(document, 'button', 'ru-button', 'Удалить все мои идеи');
  clearAll.type = 'button'; clearAll.hidden = true;
  root.replaceChildren(heading, status, clearAll, list);

  const load = async () => {
    status.textContent = 'Загружаем историю идей…'; list.replaceChildren();
    try {
      const response = await fetchImpl('/api/v1/me/ideas', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      });
      const result = await readJson(response);
      if (response.status === 401) { root.hidden = true; return; }
      if (!response.ok || !result?.ok || !Array.isArray(result.ideas) || result.ideas.length > 50) {
        root.hidden = false;
        status.textContent = 'История идей временно недоступна. Попробуйте позже.';
        return;
      }
      root.hidden = false;
      status.textContent = result.ideas.length ? '' : 'Вы ещё не отправляли идеи.';
      clearAll.hidden = result.ideas.length === 0;
      clearAll.onclick = async () => {
        const ideas = result.ideas.filter(idea => idea && UUID.test(idea.id || ''));
        if (!ideas.length || !confirmImpl(`Удалить все ${ideas.length} ваши идеи и связанные с ними фотографии?`)) return;
        clearAll.disabled = true; let deleted = 0;
        for (const idea of ideas) {
          try {
            const response = await fetchImpl(`/api/v1/ideas/${idea.id}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
            const deletion = await readJson(response);
            if (!response.ok || !deletion?.ok) break;
            deleted++;
          } catch { break; }
        }
        await load();
        if (deleted === ideas.length) status.textContent = `Удалены все ваши идеи: ${deleted}.`;
        else status.textContent = `Удалено идей: ${deleted} из ${ideas.length}. Обновите список и повторите для оставшихся.`;
        clearAll.disabled = false;
      };
      for (const idea of result.ideas) {
        if (!idea || !UUID.test(idea.id || '') || typeof idea.text !== 'string' || idea.text.length > 1000) continue;
        const card = node(document, 'article', 'ru-idea-history-card');
        card.append(node(document, 'p', 'ru-idea-history-text', idea.text));
        const reviewStatus = idea.admin_status === 'done' ? 'Выполнено'
          : idea.admin_status === 'in_progress' ? 'В работе'
            : idea.admin_status === 'rejected' ? 'Отклонено'
              : idea.ai_status === 'pending' ? 'Ожидает проверки безопасности'
                : 'Отправлено школьной команде';
        card.append(node(document, 'p', 'ru-idea-history-status', reviewStatus));
        const count = Number.isSafeInteger(idea.image_count) ? Math.max(0, Math.min(3, idea.image_count)) : 0;
        if (count && ['pending', 'approved'].includes(idea.image_status)) {
          const photos = node(document, 'div', 'ru-idea-history-photos');
          for (let index = 0; index < count; index++) {
            const image = document.createElement('img');
            image.src = `/api/v1/ideas/${idea.id}/images/${index}`;
            image.alt = `Фото ${index + 1} к вашей идее`;
            image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
            photos.append(image);
          }
          card.append(photos);
        }
        if (typeof idea.created_at === 'string') {
          const date = new Date(idea.created_at);
          if (Number.isFinite(date.getTime())) card.append(node(document, 'time', 'ru-idea-history-date', date.toLocaleString('ru-RU')));
        }
        const remove = node(document, 'button', 'ru-button', 'Удалить мою идею');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!confirmImpl('Удалить эту идею и связанные с ней фотографии?')) return;
          remove.disabled = true; status.textContent = 'Удаляем идею…';
          try {
            const deletion = await fetchImpl(`/api/v1/ideas/${idea.id}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
            const result = await readJson(deletion);
            if (!deletion.ok || !result?.ok) throw new Error('delete_failed');
            await load();
            if (result.image_cleanup === 'queued') status.textContent = 'Идея удалена; связанные фотографии поставлены в очередь очистки.';
          } catch { status.textContent = 'Не удалось удалить идею. Обновите историю и повторите попытку.'; remove.disabled = false; }
        });
        card.append(remove);
        list.append(card);
      }
    } catch {
      root.hidden = false;
      status.textContent = 'Нет связи с сервером. История идей не загружена.';
    }
  };
  const retry = node(document, 'button', 'ru-button', 'Повторить');
  retry.type = 'button'; retry.addEventListener('click', () => { void load(); });
  await load();
  if (root.hidden === false && /временно недоступна|не загружена/.test(status.textContent)) root.append(retry);
}

if (globalThis.document) void initializeIdeaHistory();
