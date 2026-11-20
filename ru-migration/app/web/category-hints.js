const CATEGORY_HINT_KEYWORDS = Object.freeze({
  'Вещи': ['прод', 'отдам', 'куплю', 'покуп', 'обмен', 'вещ', 'одежд', 'обув', 'книг', 'телефон', 'смартфон', 'планшет', 'компьютер', 'ноутбук', 'наушник', 'игрушк', 'аксессуар', 'рюкзак', 'велосипед', 'самокат', 'шлем', 'приставк', 'консол', 'монитор', 'клавиатур', 'мыш', 'куртк', 'кроссовк', 'ботинк', 'футболк', 'плать', 'сумк', 'зарядк', 'час', 'косметич', 'картридж', 'колонк', 'гаджет'],
  'Услуги': ['репетитор', 'помощ', 'услуг', 'ремонт', 'почин', 'настрой', 'установ', 'уборк', 'выгул', 'тренер', 'трениров', 'нян', 'перевод', 'научу', 'достав', 'соберу', 'настрою', 'починю', 'обучу', 'проведу занят'],
  'Творчество': ['творчеств', 'нарис', 'рисован', 'рисунок', 'иллюстрац', 'логотип', 'дизайн', 'макет', 'арт', 'фотограф', 'фотосесс', 'видеомонтаж', 'анимац', 'стикер', 'обложк', 'портрет', 'картин', 'вяз', 'хендмейд', 'handmade', 'брелок', 'украшен', 'декор', 'музык', 'песн', 'озвуч', 'комикс', '3d'],
  'Учёба': ['конспект', 'решебник', 'учебник', 'подготов', 'огэ', 'егэ', 'экзамен', 'контрольн', 'урок', 'домашн', 'задач', 'сочинен', 'реферат', 'доклад', 'презентац', 'учеб', 'задан', 'школ', 'предмет', 'математ', 'физик', 'хим', 'биолог', 'русск', 'английск', 'географ', 'истор'],
  'Мероприятия': ['встреч', 'концерт', 'квиз', 'фестивал', 'матч', 'турнир', 'мероприят', 'экскурс', 'вечерин', 'соревнован', 'олимпиад', 'собрани', 'дискотек', 'кинопоказ', 'праздник', 'мастер класс', 'конкурс'],
});

const STRONG_INTENTS = [
  ['Вещи', /(^| )(продам|куплю|отдам|обменяю)( |$)/],
  ['Услуги', /(^| )(репетитор|ремонт|починю|настрою|выгул|уборка|окажу услугу|окажу услуги)( |$)/],
  ['Творчество', /(^| )(нарисую|создам логотип|создам иллюстрацию|сделаю дизайн|сделаю обложку|свяжу|вяжу)( |$)/],
  ['Учёба', /(^| )(конспект|решебник|учебник|подготовка к огэ|подготовка к егэ|домашнее задание|контрольная)( |$)/],
  ['Мероприятия', /(^| )(квиз|фестиваль|концерт|турнир|встреча|матч|экскурсия)( |$)/],
];

function normalize(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

function matches(value, keywords) {
  const text = normalize(value);
  if (!text) return 0;
  const words = text.split(/\s+/);
  return keywords.filter(keyword => keyword.includes(' ')
    ? text.includes(keyword)
    : words.some(word => word.startsWith(keyword))).length;
}

export function suggestListingCategories(title, description, { allowEvents = true } = {}) {
  const normalizedTitle = normalize(title);
  const normalizedAll = normalize(`${title || ''} ${description || ''}`);
  const strongMatch = STRONG_INTENTS.find(([category, pattern]) => (allowEvents || category !== 'Мероприятия') && pattern.test(normalizedTitle));
  if (strongMatch) return [strongMatch[0]];
  if (!allowEvents && /(^| )(квиз|фестивал|концерт|турнир|встреч|матч|экскурс|мероприят)( |$)/.test(normalizedAll)) return [];
  const candidates = Object.entries(CATEGORY_HINT_KEYWORDS)
    .filter(([category]) => allowEvents || category !== 'Мероприятия')
    .map(([category, keywords]) => ({ category, score: matches(title, keywords) * 3 + matches(description, keywords) }));
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || candidates[0].score === 0) return [];
  return candidates.filter(item => item.score === candidates[0].score).slice(0, 3).map(item => item.category);
}

export function initializeCategoryHints({ document = globalThis.document } = {}) {
  const form = document?.getElementById?.('ruListingForm');
  const hint = document?.getElementById?.('ruCategoryHint');
  const title = form?.elements?.title;
  const description = form?.elements?.description;
  const category = form?.elements?.category;
  if (!form || !hint || !title || !description || !category) return;
  const eventOption = Array.from(category.options || []).find(option => option.value === 'Мероприятия');
  const update = () => {
    const input = `${title.value || ''} ${description.value || ''}`.trim();
    if (!input) { hint.textContent = 'Начните вводить название и описание — FAM подскажет подходящую категорию.'; return; }
    const suggestions = suggestListingCategories(title.value, description.value, { allowEvents: !eventOption || !eventOption.disabled && !eventOption.hidden });
    if (!suggestions.length) { hint.textContent = 'Пока не могу уверенно определить категорию. Проверьте текст и выберите её вручную.'; return; }
    hint.textContent = suggestions.length === 1 && category.value === suggestions[0]
      ? `По тексту подходит категория «${suggestions[0]}».`
      : `По тексту может подойти: ${suggestions.map(value => `«${value}»`).join(', ')}. Проверьте выбор.`;
  };
  title.addEventListener('input', update);
  description.addEventListener('input', update);
  update();
}

if (globalThis.document) initializeCategoryHints();
