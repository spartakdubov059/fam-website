const STAFF_ROLES = new Set(['school_admin', 'council_member']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_KEY = /^pending\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;
const AVATAR_URL = /^\/api\/v1\/avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/photo$/i;

function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

async function json(response) {
  try { return await response.json(); } catch { return null; }
}

export async function initializeAvatarWorkflow({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  if (!document || typeof fetchImpl !== 'function') return;
  const section = document.getElementById('ruAvatarWorkflow');
  const reviewRoot = document.getElementById('ruAvatarReviewQueue');
  const moderationPanel = document.getElementById('ruModeration');
  if (!section) return;

  let me;
  try {
    const response = await fetchImpl('/api/v1/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return;
    me = await json(response);
  } catch { return; }
  if (!me?.ok || !me.profile?.id) return;

  section.hidden = false;
  section.append(node(document, 'h2', '', 'Фото профиля'));
  const status = node(document, 'p', 'ru-note', 'Новая фотография останется закрытой до проверки школьным модератором.');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  section.append(status);
  if (typeof me.profile.avatar_url === 'string' && AVATAR_URL.test(me.profile.avatar_url)) {
    const current = document.createElement('img');
    current.src = me.profile.avatar_url; current.alt = 'Текущее фото профиля';
    current.width = 80; current.height = 80; current.loading = 'lazy';
    section.append(current);
  }

  const form = document.createElement('form'); form.className = 'ru-avatar-form';
  const label = node(document, 'label', '', 'Выберите JPEG, PNG или WebP (до 2 МБ)');
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.name = 'avatar'; fileInput.accept = 'image/jpeg,image/png,image/webp';
  label.append(fileInput);
  const submit = node(document, 'button', 'ru-button', 'Отправить на проверку'); submit.type = 'submit';
  form.append(label, submit); section.append(form);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file || !IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      status.textContent = 'Выберите JPEG, PNG или WebP размером не более 2 МБ.';
      return;
    }
    submit.disabled = true;
    let imageKey = null;
    try {
      status.textContent = 'Загружаем фото в российское хранилище…';
      const uploadResponse = await fetchImpl('/api/v1/avatars/media/pending', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': file.type, accept: 'application/json' }, body: file,
      });
      const upload = await json(uploadResponse);
      if (!uploadResponse.ok || typeof upload?.image?.key !== 'string' || !IMAGE_KEY.test(upload.image.key)) throw new Error('upload_failed');
      imageKey = upload.image.key;
      const response = await fetchImpl('/api/v1/me/avatar', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ image_key: imageKey }),
      });
      const result = await json(response);
      if (!response.ok || !result?.ok || result.status !== 'pending') throw new Error('review_unavailable');
      imageKey = null;
      form.reset();
      status.textContent = 'Фото отправлено модераторам вашей школы. Старое фото останется до решения.';
    } catch {
      if (imageKey) {
        const objectId = imageKey.split('/').at(-1)?.replace(/\.webp$/i, '');
        if (UUID.test(objectId || '')) {
          try { await fetchImpl(`/api/v1/media/pending/${objectId}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }); } catch { /* cleanup can retry later */ }
        }
      }
      status.textContent = 'Не удалось отправить фото. Проверьте подключение и попробуйте позже.';
    } finally { submit.disabled = false; }
  });

  if (!reviewRoot || !STAFF_ROLES.has(me.profile.role)) return;
  moderationPanel.hidden = false;
  const reviewPanel = node(document, 'section', 'ru-moderation-card');
  reviewPanel.append(node(document, 'h3', '', 'Фото профиля на проверке'));
  const reviewStatus = node(document, 'p', 'ru-note', '');
  reviewStatus.setAttribute('role', 'status'); reviewStatus.setAttribute('aria-live', 'polite');
  const list = node(document, 'div', 'ru-avatar-review-list', '');
  reviewPanel.append(reviewStatus, list); reviewRoot.replaceChildren(reviewPanel);

  async function loadReviews() {
    reviewStatus.textContent = 'Загружаем очередь…'; list.replaceChildren();
    try {
      const response = await fetchImpl('/api/v1/avatars/moderation', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      const result = await json(response);
      if (!response.ok || !result?.ok || !Array.isArray(result.requests)) throw new Error('queue_unavailable');
      reviewStatus.textContent = result.requests.length ? '' : 'Фото профиля на проверке нет.';
      for (const item of result.requests) {
        if (!item || !UUID.test(item.id || '') || typeof item.photo_url !== 'string' || !AVATAR_URL.test(item.photo_url)) continue;
        const card = node(document, 'article', 'ru-moderation-card');
        const photo = document.createElement('img');
        photo.src = item.photo_url; photo.alt = 'Фото профиля на проверке'; photo.width = 80; photo.height = 80; photo.loading = 'lazy';
        card.append(photo);
        if (typeof item.created_at === 'string') card.append(node(document, 'p', '', `Отправлено: ${new Date(item.created_at).toLocaleString('ru-RU')}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        for (const [decision, labelText] of [['approve', 'Одобрить'], ['reject', 'Отклонить']]) {
          const button = node(document, 'button', 'ru-button', labelText); button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const decisionResponse = await fetchImpl(`/api/v1/avatars/${item.id}/moderation`, {
                method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
                headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ decision }),
              });
              const decided = await json(decisionResponse);
              if (!decisionResponse.ok || !decided?.ok) throw new Error('decision_unavailable');
              await loadReviews();
            } catch {
              reviewStatus.textContent = 'Не удалось сохранить решение. Обновите очередь и попробуйте ещё раз.';
              button.disabled = false;
            }
          });
          actions.append(button);
        }
        card.append(actions); list.append(card);
      }
    } catch { reviewStatus.textContent = 'Не удалось загрузить очередь фотографий.'; }
  }
  const refresh = node(document, 'button', 'ru-button', 'Обновить очередь'); refresh.type = 'button';
  refresh.addEventListener('click', loadReviews); reviewPanel.append(refresh);
  await loadReviews();
}

if (globalThis.document) void initializeAvatarWorkflow();
