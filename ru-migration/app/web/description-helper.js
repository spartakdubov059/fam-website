const DESCRIPTION_TEMPLATES = Object.freeze({
  'Вещи': ['Предмет: {title}.', 'Состояние: [укажите реальное состояние].', 'Модель и характеристики: [уточните важные детали].', 'Комплектация: [перечислите, что входит].', '{price}', 'Передача: [укажите безопасную передачу в общественном месте].'],
  'Услуги': ['Услуга: {title}.', 'Что входит: [опишите конкретные действия].', 'Для кого: [укажите, кому подходит услуга].', 'Формат и время: [укажите онлайн/очно и доступное время].', '{price}'],
  'Творчество': ['Работа: {title}.', 'Что будет создано: [опишите результат].', 'Формат, размер или материалы: [уточните детали].', 'Сроки: [укажите реальный срок выполнения].', '{price}'],
  'Учёба': ['Предмет или тема: {title}.', 'С чем помогу: [укажите конкретные темы или задания].', 'Уровень: [укажите класс или уровень подготовки].', 'Формат: [очно или онлайн].', 'Расписание: [укажите удобное время].', '{price}'],
  'Мероприятия': ['Мероприятие: {title}.', 'Программа: [кратко опишите, что будет происходить].', 'Дата и время: [укажите дату и время].', 'Место: [укажите публичную площадку, не домашний адрес].', 'Участие: [укажите условия и количество мест].'],
});

const DETAIL_RULES = Object.freeze({
  'Вещи': [['состояние предмета', /состояни|новый|новая|новое|б у/], ['модель и характеристики', /модел|характерист|размер|памят|объем|цвет/], ['комплектацию', /комплект|короб|заряд|аксессуар/], ['условия передачи', /передач|встреч|забрать|достав/]],
  'Услуги': [['что входит в услугу', /включ|входит|делаю|провед|предостав|помога/], ['кому подходит услуга', /кому|для кого|подойдет|подходит/], ['формат и время', /онлайн|очно|время|распис|срок|дата/]],
  'Творчество': [['какой результат будет создан', /созда|нарис|иллюстрац|логотип|дизайн|макет|работа/], ['формат, размер или материалы', /формат|размер|материал|цвет|цифров|бумаж/], ['сроки выполнения', /срок|дата|дней|недел|готов/]],
  'Учёба': [['конкретные темы и предмет', /тем|предмет|математ|физик|хим|биолог|английск|русск|истор/], ['класс или уровень', /класс|уров|подготов|начальн|средн|старш/], ['формат занятий', /онлайн|очно|дистанц|встреч/], ['расписание', /распис|время|дата|длительност/]],
  'Мероприятия': [['программу мероприятия', /программ|будет|состо|участ/], ['дату и время', /дата|числа|время|час|ноябр|декабр|январ/], ['публичное место проведения', /место|площад|зал|школ|адрес/], ['условия участия', /участ|бесплат|стоим|регистрац|мест/]],
});

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-яё0-9]+/giu, ' ').trim();
}

export function normalizeDescriptionDraft(value) {
  return String(value || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    let text = line.replace(/[ \t]+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/([!?])\1+/g, '$1')
      .replace(/([,;:!?])(?=\S)/g, '$1 ').replace(/([!?])(?:\s*[!?])+/g, '$1').trim();
    if (!text) return '';
    text = text.replace(/(^|[.!?]\s+)([a-zа-яё])/giu, (_match, prefix, letter) => prefix + letter.toLocaleUpperCase('ru-RU'));
    text = text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);
    if (!/[.!?…]$/.test(text) && !/[:;]$/.test(text)) text += '.';
    return text;
  }).filter(Boolean).join('\n');
}

export function buildDescriptionTemplate({ title = '', category = 'Вещи', price = '' } = {}) {
  const safeTitle = String(title).trim() || '[укажите название]';
  const priceLine = String(price).trim() ? `Цена: ${String(price).trim()}` : 'Цена: [укажите стоимость или напишите «Бесплатно»]';
  return (DESCRIPTION_TEMPLATES[category] || DESCRIPTION_TEMPLATES['Вещи'])
    .map(line => line.replaceAll('{title}', safeTitle).replaceAll('{price}', priceLine)).join('\n');
}

export function getMissingDescriptionSuggestions({ description = '', category = 'Вещи', price = '' } = {}) {
  const text = normalizeText(description);
  const missing = (DETAIL_RULES[category] || DETAIL_RULES['Вещи']).filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
  if (!String(price).trim() && category !== 'Мероприятия') missing.push('стоимость или отметку «Бесплатно»');
  return missing;
}

export function initializeDescriptionHelper({ document = globalThis.document } = {}) {
  const form = document?.getElementById?.('ruListingForm');
  const title = form?.elements?.title;
  const description = form?.elements?.description;
  const category = form?.elements?.category;
  const price = form?.elements?.price_text;
  const toggle = document?.getElementById?.('ruDescriptionHelperToggle');
  const panel = document?.getElementById?.('ruDescriptionHelper');
  const draft = document?.getElementById?.('ruDescriptionDraft');
  const note = document?.getElementById?.('ruDescriptionHelperNote');
  const suggestions = document?.getElementById?.('ruDescriptionSuggestions');
  const apply = document?.getElementById?.('ruDescriptionApply');
  const close = document?.getElementById?.('ruDescriptionClose');
  if (![form, title, description, category, price, toggle, panel, draft, note, suggestions, apply, close].every(Boolean)) return;

  const render = () => {
    const hasDescription = Boolean(description.value.trim());
    toggle.textContent = hasDescription ? '✦ Улучшить описание' : '✦ Составить описание';
    if (panel.hidden) return;
    note.textContent = hasDescription
      ? 'Исправляются только пробелы, пунктуация и заглавные буквы. Смысл и факты не меняются — проверьте результат.'
      : 'Это заготовка с вопросами, а не готовые факты. Заполните или удалите подсказки в квадратных скобках. Не указывайте телефон, домашний адрес и личные данные.';
    draft.value = hasDescription ? normalizeDescriptionDraft(description.value)
      : buildDescriptionTemplate({ title: title.value, category: category.value, price: price.value });
    const missing = getMissingDescriptionSuggestions({ description: description.value, category: category.value, price: price.value });
    suggestions.textContent = missing.length
      ? `Чтобы объявление было понятнее, можно уточнить: ${missing.join('; ')}.`
      : 'Основные детали указаны. Проверьте точность текста перед публикацией.';
  };
  toggle.addEventListener('click', () => { panel.hidden = false; render(); draft.focus(); });
  close.addEventListener('click', () => { panel.hidden = true; });
  for (const input of [title, description, category, price]) input.addEventListener('input', render);
  category.addEventListener('change', render);
  price.addEventListener('change', render);
  apply.addEventListener('click', () => {
    const value = String(draft.value || '').trim();
    if (!value) { note.textContent = 'Черновик пуст. Добавьте текст или откройте шаблон.'; return; }
    if (value.length > 1000) { note.textContent = 'Черновик длиннее лимита FAM в 1000 символов. Сократите его перед применением.'; return; }
    description.value = value;
    description.dispatchEvent(new Event('input', { bubbles: true }));
    note.textContent = 'Текст перенесён в описание. Проверьте его и заполните недостающие детали.';
    render(); description.focus();
  });
  render();
}

if (globalThis.document) initializeDescriptionHelper();
