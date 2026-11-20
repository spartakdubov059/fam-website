function node(document, tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

async function readJson(response) { try { return await response.json(); } catch { return null; } }

export async function initializeProfileSettings({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  if (!document || typeof fetchImpl !== 'function' || document.getElementById('ruProfileSettings')) return;
  const listingForm = document.getElementById('ruListingForm');
  const shell = listingForm?.parentElement;
  if (!shell) return;

  const showUnavailable = message => {
    const section = node(document, 'section', 'ru-account-workflow');
    section.id = 'ruProfileSettings';
    section.setAttribute('aria-label', 'Настройки профиля');
    section.append(node(document, 'h2', '', 'Профиль временно недоступен'));
    const status = node(document, 'p', 'ru-note', message);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    section.append(status);
    if (typeof listingForm.before === 'function') listingForm.before(section);
    else shell.append(section);
  };

  let response;
  let data;
  try {
    response = await fetchImpl('/api/v1/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    data = await readJson(response);
  } catch {
    showUnavailable('Не удалось загрузить профиль. Данные аккаунта не считаются удалёнными. Проверьте соединение и попробуйте позже.');
    return;
  }
  if (!response.ok || !data?.ok || !data.profile?.id) {
    if (response.status !== 401) showUnavailable(response.status === 403
      ? 'Сервис не смог подтвердить профиль. Данные аккаунта не считаются удалёнными; попробуйте позже или обратитесь к администратору школы.'
      : 'Не удалось загрузить профиль. Данные аккаунта не считаются удалёнными. Проверьте соединение и попробуйте позже.');
    return;
  }

  const profile = data.profile;
  const section = node(document, 'section', 'ru-account-workflow');
  section.id = 'ruProfileSettings';
  section.setAttribute('aria-label', 'Настройки профиля');
  section.append(node(document, 'h2', '', 'Мой профиль'));
  section.append(node(document, 'p', 'ru-note', 'Укажите имя и сведения о себе. Изменения относятся только к вашему аккаунту.'));
  const form = node(document, 'form', 'ru-listing-form');
  form.id = 'ruProfileSettingsForm';
  const field = (name, title, type = 'text') => {
    const label = node(document, 'label', '', title);
    const input = document.createElement(type === 'select' ? 'select' : 'input');
    input.name = name;
    if (type !== 'select') input.type = type;
    label.append(input);
    return { label, input };
  };
  const first = field('first_name', 'Имя'); first.input.maxLength = 60; first.input.required = true; first.input.value = profile.first_name || '';
  const last = field('last_name', 'Фамилия'); last.input.maxLength = 60; last.input.required = true; last.input.value = profile.last_name || '';
  const person = field('person_type', 'Кто вы', 'select'); person.input.required = true;
  for (const [value, title] of [['student', 'Ученик'], ['school_staff', 'Сотрудник школы'], ['parent', 'Родитель']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = title; person.input.append(option);
  }
  person.input.value = ['student', 'school_staff', 'parent'].includes(profile.person_type) ? profile.person_type : 'student';
  const schoolClass = field('class_name', 'Класс, например 8А'); schoolClass.input.maxLength = 8; schoolClass.input.autocomplete = 'off'; schoolClass.input.value = profile.class_name || '';
  const staffPosition = field('staff_position', 'Должность в школе'); staffPosition.input.maxLength = 100; staffPosition.input.value = profile.staff_position || '';
  const verification = node(document, 'p', 'ru-note', '');
  verification.setAttribute('role', 'status'); verification.setAttribute('aria-live', 'polite');
  const updateVerification = () => {
    const isStaff = person.input.value === 'school_staff';
    verification.hidden = !isStaff;
    if (!isStaff) return;
    verification.textContent = profile.staff_verification_status === 'approved'
      ? 'Должность подтверждена администратором школы.'
      : profile.staff_verification_status === 'rejected'
        ? 'Администратор не подтвердил должность. Исправьте её и сохраните профиль, чтобы отправить исправленную должность на проверку.'
        : 'Должность ожидает проверки администратором школы. До подтверждения статус сотрудника не подтверждён.';
  };
  const updateVisibility = () => {
    schoolClass.label.hidden = person.input.value !== 'student';
    schoolClass.input.required = person.input.value === 'student';
    staffPosition.label.hidden = person.input.value !== 'school_staff';
    staffPosition.input.required = person.input.value === 'school_staff';
    updateVerification();
  };
  person.input.addEventListener('change', updateVisibility);
  updateVisibility();
  const status = node(document, 'p', 'ru-note', '');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const save = node(document, 'button', 'ru-button', 'Сохранить профиль'); save.type = 'submit';
  form.append(first.label, last.label, person.label, schoolClass.label, staffPosition.label, verification, status, save);
  section.append(form);
  if (typeof listingForm.before === 'function') listingForm.before(section); else shell.append(section);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true; status.textContent = 'Сохраняем изменения…';
    const personType = person.input.value;
    const payload = {
      first_name: first.input.value,
      last_name: last.input.value,
      person_type: personType,
      class_name: personType === 'student' ? schoolClass.input.value : '',
      staff_position: personType === 'school_staff' ? staffPosition.input.value : '',
    };
    try {
      const result = await fetchImpl('/api/v1/me', {
        method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const updated = await readJson(result);
      if (result.status === 401) status.textContent = 'Сеанс завершён. Войдите через Яндекс ID и повторите попытку.';
      else if (result.status === 400 && updated?.error === 'invalid_profile_identity') status.textContent = 'Проверьте имя, фамилию, класс и должность.';
      else if (!result.ok || !updated?.ok) status.textContent = 'Не удалось сохранить профиль. Попробуйте позже.';
      else {
        if (updated.profile?.person_type) profile.person_type = updated.profile.person_type;
        if (updated.profile?.staff_position !== undefined) profile.staff_position = updated.profile.staff_position;
        if (updated.profile?.staff_verification_status) profile.staff_verification_status = updated.profile.staff_verification_status;
        updateVerification();
        status.textContent = 'Профиль сохранён.';
      }
    } catch { status.textContent = 'Нет связи с сервером. Изменения не подтверждены.'; }
    finally { save.disabled = false; }
  });
}

if (globalThis.document) void initializeProfileSettings();
