function node(document, tag, className = '', text = '') {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

async function json(response) { try { return await response.json(); } catch { return null; } }

export async function initializeSchoolPulse({ document = globalThis.document, fetchImpl = globalThis.fetch, location = globalThis.location } = {}) {
  const root = document?.getElementById?.('ruPulse');
  if (!root || typeof fetchImpl !== 'function') return;
  const heading = node(document, 'h2', '', 'Новости и опросы школы');
  const status = node(document, 'p', 'ru-pulse-status', 'Загружаем школьную ленту…');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const feed = node(document, 'div', 'ru-pulse-feed');
  root.replaceChildren(heading, status, feed);
  let featuredCards = [];

  const request = async (path, init = {}) => {
    const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(init.headers || {}) }, ...init });
    return { response, result: await json(response) };
  };
  const login = () => {
    const link = node(document, 'a', 'ru-auth-link', 'Войти через Яндекс ID');
    link.href = '/auth/yandex/start'; feed.replaceChildren(link);
  };

  function publishFeaturedPulseCards() {
    const track = document.getElementById('ruHeroTrack');
    if (!track || typeof track.replaceChildren !== 'function') return;
    const slides = featuredCards.map(({ type, item }, index) => {
      const slide = node(document, 'div', `hero-slide hero-pulse-slide hero-pulse-${type} ru-pulse-generated`);
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-roledescription', 'слайд');
      slide.setAttribute('aria-label', `Школьная лента, слайд ${index + 1}`);
      if (type === 'poll') renderPoll(item, slide);
      else renderAnnouncement(item, slide);
      return slide;
    });
    const permanentSlides = [...track.children].filter(slide => !String(slide.className || '').split(/\s+/).includes('ru-pulse-generated'));
    track.replaceChildren(...slides, ...permanentSlides);
    const EventConstructor = document.defaultView?.Event || globalThis.Event;
    if (typeof track.dispatchEvent === 'function' && typeof EventConstructor === 'function') {
      track.dispatchEvent(new EventConstructor('famru:hero-slides-changed'));
    }
  }

  async function loadGuestEvents() {
    try {
      const response = await request('/api/v1/listings', { credentials: 'omit' });
      const listings = response.result?.listings;
      if (!response.response.ok || !Array.isArray(listings) || listings.length > 100) return false;
      const today = new Date().toISOString().slice(0, 10);
      const events = listings.filter(item => item && item.is_event === true
        && Number(item.max_seats || 0) === 0
        && (!item.event_date || (typeof item.event_date === 'string' && item.event_date >= today)))
        .slice(0, 6);
      featuredCards = events.map(event => ({ type: 'event', item: {
        title: event.title,
        body: event.description,
        kind: 'open_event',
        event_starts_at: event.event_date && event.event_time
          ? `${event.event_date}T${event.event_time}` : event.event_date || null,
      } }));
      for (const { item } of featuredCards) renderAnnouncement(item);
      return true;
    } catch { return false; }
  }

  async function load() {
    status.textContent = 'Загружаем школьную ленту…'; feed.replaceChildren(); featuredCards = [];
    try {
      const me = await request('/api/v1/me');
      if (me.response.status === 401) {
        const loaded = await loadGuestEvents();
        status.textContent = loaded
          ? 'Открытые мероприятия без записи доступны всем. Войдите через Яндекс ID, чтобы открыть новости и опросы своей школы.'
          : 'Не удалось загрузить открытые мероприятия. Войдите через Яндекс ID, чтобы открыть новости и опросы своей школы.';
        if (!loaded || feed.children.length === 0) login();
        publishFeaturedPulseCards();
        return;
      }
      if (!me.response.ok || !me.result?.profile?.school_id) { status.textContent = 'Для школьной ленты сначала получите подтверждённый профиль школы.'; return; }
      const pulse = await request('/api/v1/pulse');
      if (!pulse.response.ok || !Array.isArray(pulse.result?.announcements) || !Array.isArray(pulse.result?.polls)) throw new Error('pulse_unavailable');
      status.textContent = '';
      if (!pulse.result.announcements.length && !pulse.result.polls.length) feed.append(node(document, 'p', 'ru-pulse-empty', 'В ленте пока нет новостей и опросов.'));
      featuredCards = [
        ...pulse.result.announcements.map(item => ({ type: item.kind === 'important' ? 'important' : item.kind === 'open_event' ? 'event' : 'news', item })),
        ...pulse.result.polls.map(item => ({ type: 'poll', item })),
      ];
      for (const item of pulse.result.announcements) renderAnnouncement(item);
      for (const poll of pulse.result.polls) renderPoll(poll);
      if (['school_admin', 'council_member'].includes(me.result.profile.role)) renderPublishForms();
      publishFeaturedPulseCards();
    } catch {
      status.textContent = 'Не удалось загрузить школьную ленту. Проверьте подключение и попробуйте ещё раз.';
      const retry = node(document, 'button', 'ru-button', 'Повторить'); retry.type = 'button'; retry.addEventListener('click', () => { void load(); }); feed.append(retry);
    }
  }

  function renderAnnouncement(item, target = feed) {
    if (!item || typeof item.title !== 'string' || typeof item.body !== 'string') return;
    const card = node(document, 'article', `ru-pulse-card ru-pulse-${item.kind === 'important' ? 'important' : item.kind === 'open_event' ? 'event' : 'news'}`);
    const label = item.kind === 'important' ? 'Важно' : item.kind === 'open_event' ? 'Открытое мероприятие' : 'Новости школы';
    card.append(node(document, 'p', 'ru-pulse-kind', label), node(document, 'h3', '', item.title), node(document, 'p', 'ru-pulse-body', item.body));
    const dateValue = item.event_starts_at || item.published_at;
    if (typeof dateValue === 'string') {
      const date = new Date(dateValue);
      if (!Number.isNaN(date.getTime())) card.append(node(document, 'time', 'ru-pulse-date', date.toLocaleString('ru-RU')));
    }
    target.append(card);
  }

  function renderPoll(poll, target = feed) {
    if (!poll || typeof poll.id !== 'string' || typeof poll.question !== 'string' || !Array.isArray(poll.options)) return;
    const card = node(document, 'article', 'ru-pulse-card ru-pulse-poll');
    card.append(node(document, 'p', 'ru-pulse-kind', 'Опрос'), node(document, 'h3', '', poll.question));
    const closes = new Date(poll.closes_at);
    const closed = !Number.isFinite(closes.getTime()) || closes.getTime() <= Date.now();
    const totalVotes = Number.isSafeInteger(poll.total_votes) ? Math.max(0, poll.total_votes) : 0;
    const voted = Number.isInteger(poll.my_vote) && poll.my_vote >= 0 && poll.my_vote < poll.options.length;
    const countsValid = Array.isArray(poll.counts) && poll.counts.length === poll.options.length
      && poll.counts.every(count => Number.isSafeInteger(count) && count >= 0)
      && poll.counts.reduce((sum, count) => sum + count, 0) === totalVotes;
    const showResults = countsValid && (voted || closed) && totalVotes >= 5;
    const options = node(document, 'div', 'ru-pulse-options');
    for (const [index, label] of poll.options.slice(0, 8).entries()) {
      if (typeof label !== 'string') continue;
      const option = node(document, 'div', 'ru-pulse-option');
      const selected = voted && poll.my_vote === index;
      if (showResults) {
        const percent = totalVotes ? Math.round(100 * poll.counts[index] / totalVotes) : 0;
        option.append(node(document, 'span', selected ? 'ru-pulse-vote-label is-selected' : 'ru-pulse-vote-label',
          selected ? `Ваш выбор: ${label}` : label));
        option.append(node(document, 'span', 'ru-pulse-vote-count', `${percent}%`));
      } else {
        const vote = node(document, 'button', 'ru-pulse-vote', label); vote.type = 'button';
        vote.disabled = closed || voted;
        vote.setAttribute('aria-pressed', String(selected));
        if (selected) vote.textContent = `Ваш выбор: ${label}`;
        vote.addEventListener('click', async () => {
          vote.disabled = true;
          try {
            const sent = await request(`/api/v1/pulse/polls/${poll.id}/votes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice_index: index }) });
            if (!sent.response.ok) {
              status.textContent = sent.result?.error === 'already_voted' ? 'Голос уже учтён.'
                : sent.result?.error === 'poll_closed' ? 'Опрос уже закрыт.' : 'Не удалось сохранить голос.';
              vote.disabled = false; return;
            }
            await load();
          } catch { status.textContent = 'Нет связи с сервером. Голос не подтверждён.'; vote.disabled = false; }
        });
        option.append(vote);
      }
      options.append(option);
    }
    card.append(options);
    const message = closed ? 'Опрос завершён'
      : voted ? (showResults ? 'Спасибо за голос!' : 'Спасибо! Итоги появятся после 5 голосов')
        : 'Один голос от одного участника';
    card.append(node(document, 'p', 'ru-pulse-poll-foot', message));
    if (Number.isSafeInteger(poll.total_votes)) card.append(node(document, 'p', 'ru-pulse-total', `Всего голосов: ${totalVotes}`));
    if (Number.isFinite(closes.getTime())) card.append(node(document, 'time', 'ru-pulse-date', `До ${closes.toLocaleString('ru-RU')}`));
    target.append(card);
  }

  function renderPublishForms() {
    const panel = node(document, 'section', 'ru-pulse-publish');
    panel.append(node(document, 'h3', '', 'Опубликовать для своей школы'));
    const announcement = document.createElement('form'); announcement.className = 'ru-pulse-form';
    const title = node(document, 'input'); title.name = 'title'; title.required = true; title.minLength = 4; title.maxLength = 90; title.placeholder = 'Заголовок';
    const body = node(document, 'textarea'); body.name = 'body'; body.required = true; body.minLength = 4; body.maxLength = 450; body.placeholder = 'Текст объявления';
    const kind = document.createElement('select'); kind.name = 'kind';
    for (const [value, label] of [['news', 'Новость'], ['important', 'Важное объявление'], ['open_event', 'Открытое мероприятие']]) { const option = node(document, 'option', '', label); option.value = value; kind.append(option); }
    const starts = node(document, 'input'); starts.type = 'datetime-local'; starts.name = 'event_starts_at'; starts.hidden = true;
    kind.addEventListener('change', () => { starts.hidden = kind.value !== 'open_event'; starts.required = !starts.hidden; });
    const announceStatus = node(document, 'p', 'ru-pulse-form-status', ''); announceStatus.setAttribute('role', 'status');
    const announceSubmit = node(document, 'button', 'ru-button', 'Опубликовать новость'); announceSubmit.type = 'submit';
    announcement.append(title, body, kind, starts, announceSubmit, announceStatus);
    announcement.addEventListener('submit', async event => {
      event.preventDefault(); announceSubmit.disabled = true; announceStatus.textContent = 'Публикуем…';
      const eventStartsAt = starts.value ? new Date(starts.value).toISOString() : null;
      try {
        const sent = await request('/api/v1/pulse/announcements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, body: body.value, kind: kind.value, event_starts_at: eventStartsAt }) });
        if (!sent.response.ok) { announceStatus.textContent = sent.result?.error === 'daily_announcement_limit' ? 'Достигнут дневной лимит новостей.' : 'Проверьте текст: он не должен содержать контакты или небезопасные сведения.'; return; }
        await load();
      } catch { announceStatus.textContent = 'Не удалось опубликовать новость.'; }
      finally { announceSubmit.disabled = false; }
    });

    const pollForm = document.createElement('form'); pollForm.className = 'ru-pulse-form';
    const question = node(document, 'input'); question.name = 'question'; question.required = true; question.minLength = 8; question.maxLength = 140; question.placeholder = 'Вопрос для опроса';
    const choices = [];
    for (let index = 0; index < 8; index++) { const choice = node(document, 'input'); choice.name = `option_${index}`; choice.maxLength = 70; choice.required = index < 2; choice.placeholder = `Вариант ${index + 1}`; choices.push(choice); }
    const pollStatus = node(document, 'p', 'ru-pulse-form-status', ''); pollStatus.setAttribute('role', 'status');
    const pollSubmit = node(document, 'button', 'ru-button', 'Создать опрос'); pollSubmit.type = 'submit';
    pollForm.append(question, ...choices, pollSubmit, pollStatus);
    pollForm.addEventListener('submit', async event => {
      event.preventDefault(); pollSubmit.disabled = true; pollStatus.textContent = 'Создаём опрос…';
      const options = choices.map(choice => choice.value.trim()).filter(Boolean);
      try {
        const sent = await request('/api/v1/pulse/polls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: question.value, options }) });
        if (!sent.response.ok) { pollStatus.textContent = sent.result?.error === 'daily_poll_limit' ? 'Достигнут дневной лимит опросов.' : 'Проверьте вопрос и варианты ответов.'; return; }
        await load();
      } catch { pollStatus.textContent = 'Не удалось создать опрос.'; }
      finally { pollSubmit.disabled = false; }
    });
    panel.append(announcement, pollForm); feed.append(panel);
  }

  await load();
}

if (globalThis.document) void initializeSchoolPulse();
