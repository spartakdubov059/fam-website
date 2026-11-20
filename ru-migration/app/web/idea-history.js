const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
async function readJson(response) { try { return await response.json(); } catch { return null; } }

export async function initializeIdeaHistory({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  const root = document?.getElementById?.('ruIdeaHistory');
  if (!root || typeof fetchImpl !== 'function') return;
  root.hidden = true;
  const heading = node(document, 'h2', '', 'Мои идеи');
  const status = node(document, 'p', 'ru-note', 'Загружаем историю идей…');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = node(document, 'div', 'ru-idea-history-list');
  root.replaceChildren(heading, status, list);

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
