const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PENDING_KEY = /^pending\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export async function initializeListingSubmission({ document = globalThis.document, fetchImpl = globalThis.fetch,
  FormDataCtor = globalThis.FormData, location = globalThis.location } = {}) {
  if (!document || typeof fetchImpl !== 'function') return;
  const form = document.getElementById('ruListingForm');
  const status = document.getElementById('ruSubmitStatus');
  const login = document.querySelector('.ru-auth-link');
  const logout = document.getElementById('ruLogout');
  if (!form || !status) return;

  let ideaForm;
  try {
    const response = await fetchImpl('/api/v1/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const result = await readJson(response);
    if (!result?.ok || !result.profile?.id) return;
    form.hidden = false;
    status.textContent = 'Объявление и фото будут отправлены на проверку вашей школы.';
    ideaForm = createIdeaForm(document, form);
    if (login) login.hidden = true;
    if (logout) logout.hidden = false;
  } catch { return; }

  if (logout) logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      const response = await fetchImpl('/auth/yandex/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) location?.reload?.();
      else status.textContent = 'Не удалось завершить сеанс. Попробуйте ещё раз.';
    } catch { status.textContent = 'Не удалось завершить сеанс. Проверьте подключение.'; }
    finally { logout.disabled = false; }
  });

  if (ideaForm) ideaForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = ideaForm.querySelector('button[type="submit"]');
    const text = String(ideaForm.elements.idea?.value || '').trim();
    if (submit) submit.disabled = true;
    const ideaStatus = ideaForm.querySelector('[role="status"]');
    ideaStatus.textContent = 'Передаём предложение на проверку…';
    try {
      const response = await fetchImpl('/api/v1/ideas', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text }),
      });
      const result = await readJson(response);
      if (!response.ok || !result?.ok) {
        ideaStatus.textContent = result?.error === 'rejected'
          ? 'Предложение не принято. Уберите личные данные и попробуйте снова.'
          : 'Не удалось отправить предложение. Проверьте текст и подключение.';
        return;
      }
      ideaForm.reset();
      ideaStatus.textContent = result.status === 'pending'
        ? 'Предложение сохранено и ждёт проверки безопасности.'
        : 'Предложение отправлено школьной команде.';
    } catch {
      ideaStatus.textContent = 'Не удалось отправить предложение. Проверьте подключение и попробуйте позже.';
    } finally { if (submit) submit.disabled = false; }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const data = new FormDataCtor(form);
    const file = form.elements.photo.files?.[0] || null;
    if (file && (!IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_IMAGE_BYTES)) {
      status.textContent = 'Выберите JPEG, PNG или WebP размером не более 5 МБ.';
      return;
    }
    if (submit) submit.disabled = true;
    let imageKey = null;
    try {
      status.textContent = 'Отправляем объявление на проверку…';
      if (file) {
        const upload = await fetchImpl('/api/v1/media/pending', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': file.type }, body: file,
        });
        const uploaded = await readJson(upload);
        if (!upload.ok || typeof uploaded?.image?.key !== 'string' || !PENDING_KEY.test(uploaded.image.key)) throw new Error('upload_failed');
        imageKey = uploaded.image.key;
      }
      const payload = {
        title: String(data.get('title') || ''),
        description: String(data.get('description') || ''),
        category: String(data.get('category') || ''),
        price_text: String(data.get('price_text') || '').trim() || 'Бесплатно',
        ...(imageKey ? { image_key: imageKey } : {}),
      };
      const submitted = await fetchImpl('/api/v1/listings', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await readJson(submitted);
      if (!submitted.ok || !result?.ok || result.status !== 'pending') throw new Error('submit_failed');
      form.reset();
      status.textContent = 'Объявление отправлено. Оно появится на доске после проверки; фото проверяется отдельно.';
    } catch {
      if (imageKey) {
        const photoId = imageKey.split('/').at(-1)?.replace(/\.webp$/i, '');
        try {
          const cleanup = await fetchImpl(`/api/v1/media/pending/${photoId}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
          if (!cleanup.ok) status.textContent = 'Не удалось отправить объявление. Фото сохранено закрытым и не опубликовано; автоматическая уборка ещё не настроена.';
          else status.textContent = 'Не удалось отправить объявление. Временное фото удалено.';
        } catch { status.textContent = 'Не удалось отправить объявление. Временное фото осталось закрытым.'; }
      } else status.textContent = 'Не удалось отправить объявление. Проверьте подключение и попробуйте снова.';
    } finally { if (submit) submit.disabled = false; }
  });
}

function createIdeaForm(document, listingForm) {
  if (document.getElementById('ruIdeaForm')) return document.getElementById('ruIdeaForm');
  const shell = listingForm.parentElement;
  if (!shell || typeof document.createElement !== 'function') return null;
  const section = document.createElement('section');
  section.className = 'ru-moderation';
  section.setAttribute('aria-label', 'Предложить школьную идею');
  const heading = document.createElement('h2'); heading.textContent = 'Предложить идею';
  const note = document.createElement('p'); note.className = 'ru-note';
  note.textContent = 'Опишите идею для школы. Не указывайте имена, телефоны, адреса и другие личные данные.';
  const form = document.createElement('form'); form.id = 'ruIdeaForm'; form.className = 'ru-listing-form';
  const label = document.createElement('label'); label.textContent = 'Предложение';
  const input = document.createElement('textarea'); input.name = 'idea'; input.maxLength = 1000; input.required = true;
  label.append(input);
  const status = document.createElement('p'); status.className = 'ru-note'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const submit = document.createElement('button'); submit.className = 'ru-button'; submit.type = 'submit'; submit.textContent = 'Отправить идею';
  form.append(label, status, submit);
  section.append(heading, note, form);
  shell.append(section);
  return form;
}

if (globalThis.document) void initializeListingSubmission();
