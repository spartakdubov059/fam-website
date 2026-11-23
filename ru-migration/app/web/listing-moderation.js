import { requestWithEmailStepUp } from './step-up-email.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAFF_ROLES = new Set(['school_admin', 'council_member']);

function node(document, tag, className, text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  result.textContent = text;
  return result;
}

async function json(response) {
  try { return await response.json(); } catch { return null; }
}

export async function initializeListingModeration({ document = globalThis.document, fetchImpl = globalThis.fetch,
  confirmImpl = message => typeof globalThis.confirm === 'function' && globalThis.confirm(message),
  promptImpl = message => typeof globalThis.prompt === 'function' ? globalThis.prompt(message) : null } = {}) {
  if (!document || typeof fetchImpl !== 'function') return;
  const panel = document.getElementById('ruModeration');
  const status = document.getElementById('ruModerationStatus');
  const queue = document.getElementById('ruModerationQueue');
  if (!panel || !status || !queue) return;

  let me;
  try {
    const response = await fetchImpl('/api/v1/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return;
    me = await json(response);
  } catch { return; }
  if (!me?.ok || !STAFF_ROLES.has(me.profile?.role)) return;
  panel.hidden = false;

  async function deleteSchoolAccount(account) {
    if (me.profile.role !== 'school_admin' || !account || !UUID.test(account.id || '')
        || !['student', 'council_member'].includes(account.role)
        || account.id.toLowerCase() === String(me.profile.id || '').toLowerCase()) return;
    const accountCode = account.id.slice(-6).toUpperCase();
    const displayName = [account.first_name, account.last_name]
      .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()).join(' ') || 'Аккаунт участника';
    if (!confirmImpl(`Удалить аккаунт #${accountCode} (${displayName})? Будут удалены связанные публикации, переписки и файлы.`)) return;
    const confirmation = 'УДАЛИТЬ АККАУНТ УЧАСТНИКА';
    if (promptImpl(`Для окончательного удаления введите точно: ${confirmation}`) !== confirmation) {
      status.textContent = 'Удаление отменено: фраза подтверждения не совпала.';
      return;
    }
    status.textContent = 'Проверяем возможность безопасного удаления аккаунта…';
    try {
      const { response, result, stepUpError } = await requestWithEmailStepUp({ fetchImpl, promptImpl,
        url: `/api/v1/school/accounts/${encodeURIComponent(account.id)}`, init: {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ confirmation }),
      } });
      if (result?.error === 'fresh_authentication_required') {
        status.textContent = stepUpError === 'code_entry_cancelled' ? 'Подтверждение отменено. Аккаунт не изменён.'
          : 'Не удалось подтвердить действие по почте. Аккаунт не изменён.';
        return;
      }
      if (!response.ok || result?.ok !== true) throw new Error('account_deletion_failed');
      await load();
      status.textContent = 'Аккаунт и связанные данные удалены.';
    } catch {
      status.textContent = 'Не удалось удалить аккаунт. Проверьте очередь и состояние аккаунта перед повтором.';
    }
  }

  async function load() {
    status.textContent = 'Загружаем очередь…';
    try {
      const options = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
      const [response, eventResponse, profileResponse, staffVerificationResponse, roleResponse, suspensionResponse, suspensionTargetsResponse, roleManagementResponse, safetyResponse, pendingMessagesResponse, schoolOverviewResponse, schoolIdeasResponse, schoolIdeaWorkflowResponse] = await Promise.all([
        fetchImpl('/api/v1/listings/moderation', options),
        fetchImpl('/api/v1/event-registrations/review', options),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/profile-requests/review', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/staff-verifications', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/role-requests/review', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, requests: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/suspensions', options)
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, suspensions: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/suspensions/targets', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, targets: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/role-management/targets', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, targets: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/school/admin/safety-reports', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, reports: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/messages/moderation', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, messages: [] }) }),
        me.profile.role === 'school_admin' ? fetchImpl('/api/v1/school/admin/overview', options).catch(() => ({ ok: false, json: async () => null }))
          : Promise.resolve({ ok: true, json: async () => ({ ok: true, users: [], listings: [], audit: [], deletion_requests: [], suspensions: [] }) }),
        fetchImpl('/api/v1/school/ideas', options).catch(() => ({ ok: false, json: async () => null })),
        fetchImpl('/api/v1/school/ideas/workflow', options).catch(() => ({ ok: false, json: async () => null })),
      ]);
      const [result, eventResult, profileResult, staffVerificationResult, roleResult, suspensionResult, suspensionTargetsResult, roleManagementResult, safetyResult, pendingMessagesResult, schoolOverviewResult, schoolIdeasResult, schoolIdeaWorkflowResult] = await Promise.all([json(response), json(eventResponse), json(profileResponse), json(staffVerificationResponse), json(roleResponse), json(suspensionResponse), json(suspensionTargetsResponse), json(roleManagementResponse), json(safetyResponse), json(pendingMessagesResponse), json(schoolOverviewResponse), json(schoolIdeasResponse), json(schoolIdeaWorkflowResponse)]);
      if (!response.ok || !result?.ok || !Array.isArray(result.listings)
        || !eventResponse.ok || !eventResult?.ok || !Array.isArray(eventResult.applications)
        || !profileResponse.ok || !profileResult?.ok || !Array.isArray(profileResult.requests)
        || !roleResponse.ok || !roleResult?.ok || !Array.isArray(roleResult.requests)) throw new Error('queue_unavailable');
      queue.replaceChildren();
      const applications = eventResult.applications.filter(application => application
        && UUID.test(application.event_id) && UUID.test(application.user_id)
        && application.status === 'pending' && typeof application.event_title === 'string');
      const profileRequests = profileResult.requests.filter(request => request && UUID.test(request.request_id)
        && typeof request.first_name === 'string' && typeof request.last_name === 'string'
        && typeof request.class_name === 'string' && ['student', 'school_staff', 'parent'].includes(request.person_type));
      const staffVerificationsAvailable = me.profile.role !== 'school_admin'
        || (staffVerificationResponse.ok && staffVerificationResult?.ok && Array.isArray(staffVerificationResult.requests));
      const staffVerifications = me.profile.role === 'school_admin' && staffVerificationsAvailable
        ? staffVerificationResult.requests.filter(request => request && UUID.test(request.user_id)
          && typeof request.first_name === 'string' && typeof request.last_name === 'string'
          && typeof request.staff_position === 'string' && request.staff_position.length <= 100) : [];
      const roleRequests = roleResult.requests.filter(request => request && UUID.test(request.request_id)
        && ['council_member', 'school_admin'].includes(request.requested_role)
        && ['pending', 'reviewing'].includes(request.status));
      const roleManagementAvailable = me.profile.role !== 'school_admin' || (roleManagementResponse.ok && roleManagementResult?.ok && Array.isArray(roleManagementResult.targets));
      const roleManagementTargets = me.profile.role === 'school_admin' && roleManagementAvailable
        ? roleManagementResult.targets.filter(item => item && UUID.test(item.id) && ['council_member', 'school_admin'].includes(item.role)) : [];
      const suspensionsAvailable = me.profile.role !== 'school_admin'
        || (suspensionResponse.ok && suspensionResult?.ok && Array.isArray(suspensionResult.suspensions));
      const suspensions = me.profile.role === 'school_admin' && suspensionsAvailable
        ? suspensionResult.suspensions.filter(item => item && UUID.test(item.target_id)
          && ['student', 'council_member'].includes(item.target_role) && typeof item.reason === 'string'
          && typeof item.expires_at === 'string') : [];
      const safetyReportsAvailable = me.profile.role !== 'school_admin'
        || (safetyResponse.ok && safetyResult?.ok && Array.isArray(safetyResult.reports));
      const safetyReports = me.profile.role === 'school_admin' && safetyReportsAvailable
        ? safetyResult.reports.filter(item => item && /^[0-9a-f]{64}$/.test(item.fingerprint || '')
          && ['message', 'idea', 'listing', 'image'].includes(item.source_kind)
          && ['targeted_harassment', 'hate_or_discrimination', 'threat_or_intimidation', 'negative_personal_call',
            'spam_or_repeated_abuse', 'unsafe_image', 'personal_data_in_image', 'unclear_safety_signal'].includes(item.category)
          && ['medium', 'high'].includes(item.severity) && Number.isInteger(item.occurrences)) : [];
      const pendingMessagesAvailable = me.profile.role !== 'school_admin'
        || (pendingMessagesResponse.ok && pendingMessagesResult?.ok && Array.isArray(pendingMessagesResult.messages));
      const pendingMessages = me.profile.role === 'school_admin' && pendingMessagesAvailable
        ? pendingMessagesResult.messages.filter(item => item && UUID.test(item.id || '') && UUID.test(item.sender_id || '')
          && typeof item.body === 'string' && item.body.length > 0 && item.body.length <= 1000) : [];
      const schoolOverviewAvailable = me.profile.role !== 'school_admin'
        || (schoolOverviewResponse.ok && schoolOverviewResult?.ok
          && ['users', 'listings', 'audit', 'deletion_requests', 'suspensions'].every(key => Array.isArray(schoolOverviewResult[key])));
      const schoolIdeasAvailable = schoolIdeasResponse.ok && schoolIdeasResult?.ok && Array.isArray(schoolIdeasResult.ideas);
      const schoolIdeas = schoolIdeasAvailable ? schoolIdeasResult.ideas.filter(item => item && UUID.test(item.id || '')
        && typeof item.text === 'string' && item.text.length <= 1000
        && ['pending', 'approved', 'rejected'].includes(item.ai_status)
        && Array.isArray(item.image_keys) && item.image_keys.length <= 3
        && ['none', 'pending', 'approved', 'rejected'].includes(item.image_status)) : [];
      const ideaWorkflowAvailable = schoolIdeaWorkflowResponse.ok && schoolIdeaWorkflowResult?.ok && Array.isArray(schoolIdeaWorkflowResult.ideas);
      const workflowIdeas = ideaWorkflowAvailable ? schoolIdeaWorkflowResult.ideas.filter(item => item && UUID.test(item.id || '')
        && typeof item.text === 'string' && item.text.length <= 1000 && typeof item.is_own === 'boolean'
        && ['new', 'in_progress', 'done', 'rejected'].includes(item.admin_status)) : [];
      const renderSchoolIdeasPanel = () => {
        const ideasPanel = node(document, 'section', 'ru-moderation-card');
        ideasPanel.append(node(document, 'h3', '', 'Школьные идеи и фотографии'));
        if (!schoolIdeasAvailable) ideasPanel.append(node(document, 'p', '', 'Не удалось загрузить предложения школы.'));
        else if (!schoolIdeas.length) ideasPanel.append(node(document, 'p', '', 'Новых предложений нет.'));
        for (const idea of schoolIdeas) {
          const card = node(document, 'article', 'ru-moderation-card');
          card.append(node(document, 'p', '', idea.text));
          card.append(node(document, 'p', 'ru-note', idea.ai_status === 'pending' ? 'Текст ожидает решения школы.'
            : idea.ai_status === 'approved' ? 'Текст одобрен школой.' : 'Текст отклонён школой.'));
          if (idea.ai_status === 'pending') {
            const textActions = node(document, 'div', 'ru-moderation-actions');
            textActions.append(actionButton(document, 'Одобрить текст', () => patch(`/api/v1/school/ideas/${idea.id}/moderation`, { decision: 'approve' })));
            textActions.append(actionButton(document, 'Отклонить текст', () => patch(`/api/v1/school/ideas/${idea.id}/moderation`, { decision: 'reject' })));
            card.append(textActions);
          }
          const validKeys = idea.image_keys.every(key => typeof key === 'string'
            && /^pending\/[0-9a-f-]{36}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i.test(key));
          if (idea.image_status === 'pending' && validKeys && idea.image_keys.length) {
            idea.image_keys.forEach((_, index) => {
              const image = document.createElement('img');
              image.className = 'ru-listing-photo';
              image.src = `/api/v1/ideas/${idea.id}/images/${index}`;
              image.alt = `Фото к школьной идее ${index + 1}`;
              image.loading = 'lazy';
              image.referrerPolicy = 'no-referrer';
              card.append(image);
            });
            const actions = node(document, 'div', 'ru-moderation-actions');
            actions.append(actionButton(document, 'Одобрить фото', () => patch(`/api/v1/school/ideas/${idea.id}/images`, { decision: 'approve' })));
            actions.append(actionButton(document, 'Отклонить фото', () => patch(`/api/v1/school/ideas/${idea.id}/images`, { decision: 'reject' })));
            card.append(actions);
          } else if (idea.image_status === 'approved') {
            card.append(node(document, 'p', '', 'Фото одобрены и доступны школьной команде.'));
          } else if (idea.image_status === 'rejected') {
            card.append(node(document, 'p', '', 'Фото отклонены.'));
          }
          ideasPanel.append(card);
        }
        queue.append(ideasPanel);
      };
      const renderIdeaWorkflowPanel = () => {
        const workflowPanel = node(document, 'section', 'ru-moderation-card');
        workflowPanel.append(node(document, 'h3', '', 'Работа с одобренными идеями'));
        if (!ideaWorkflowAvailable) workflowPanel.append(node(document, 'p', '', 'Не удалось загрузить статусы идей школы.'));
        else if (!workflowIdeas.length) workflowPanel.append(node(document, 'p', '', 'Одобренных идей пока нет.'));
        if (ideaWorkflowAvailable && me.profile.role === 'school_admin') {
          const folderNames = { in_progress: 'идеи в работе', done: 'выполненные идеи', rejected: 'отклонённые идеи' };
          for (const [folder, label] of Object.entries(folderNames)) {
            const matches = workflowIdeas.filter(item => item.admin_status === folder);
            if (!matches.length) continue;
            workflowPanel.append(actionButton(document, `Очистить: ${label} (${matches.length})`, async () => {
              if (!confirmImpl(`Удалить ${matches.length} ${label} и связанные фотографии?`)) return;
              const confirmation = 'УДАЛИТЬ ИДЕЮ ШКОЛЫ';
              if (matches.some(item => !item.is_own)
                  && promptImpl(`Для окончательного удаления введите точно: ${confirmation}`) !== confirmation) {
                status.textContent = 'Удаление отменено: фраза подтверждения не совпала.'; return;
              }
              status.textContent = `Удаляем: ${label}…`; let deleted = 0;
              const ordered = [...matches].sort((a, b) => Number(a.is_own) - Number(b.is_own));
              for (const item of ordered) {
                try {
                  const response = await fetchImpl(`/api/v1/ideas/${item.id}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    ...(!item.is_own ? { body: JSON.stringify({ confirmation }) } : {}) });
                  const result = await json(response);
                  if (!response.ok || !result?.ok) break;
                  deleted++;
                } catch { break; }
              }
              await load();
              if (deleted === matches.length) status.textContent = `Удалены ${label}: ${deleted}.`;
              else if (!status.textContent.includes('не подтвердил')) status.textContent = `Удалено: ${deleted} из ${matches.length}. Очередь обновлена; повторите для оставшихся.`;
            }));
          }
        }
        for (const idea of workflowIdeas) {
          const card = node(document, 'article', 'ru-moderation-card');
          const labels = { new: 'Новая', in_progress: 'В работе', done: 'Выполнена', rejected: 'Отклонена' };
          card.append(node(document, 'p', '', idea.text), node(document, 'p', 'ru-note', `Статус: ${labels[idea.admin_status]}`));
          const actions = node(document, 'div', 'ru-moderation-actions');
          if (idea.admin_status === 'new') actions.append(actionButton(document, 'Взять в работу', () => patch(`/api/v1/school/ideas/workflow/${idea.id}/status`, { status: 'in_progress' })));
          if (idea.admin_status === 'new' || idea.admin_status === 'in_progress') actions.append(actionButton(document, 'Отклонить', () => patch(`/api/v1/school/ideas/workflow/${idea.id}/status`, { status: 'rejected' })));
          if (idea.admin_status === 'in_progress') actions.append(actionButton(document, 'Отметить выполненной', () => patch(`/api/v1/school/ideas/workflow/${idea.id}/status`, { status: 'done' })));
          if (me.profile.role === 'school_admin' || idea.is_own) actions.append(actionButton(document, 'Удалить идею', () => removeSchoolIdea(idea)));
          if (actions.children.length) card.append(actions);
          workflowPanel.append(card);
        }
        queue.append(workflowPanel);
      };
      if (me.profile.role === 'school_admin' && suspensionTargetsResponse.ok && suspensionTargetsResult?.ok && Array.isArray(suspensionTargetsResult.targets)) {
        const targets = suspensionTargetsResult.targets.filter(item => item && UUID.test(item.id) && ['student', 'council_member'].includes(item.role));
        if (targets.length) {
          const panel = node(document, 'section', 'ru-moderation-card');
          panel.append(node(document, 'h3', '', 'Временное ограничение действий аккаунта'));
          const note = node(document, 'p', '', 'Для выдачи и снятия ограничений потребуется одноразовый код на почту аккаунта Яндекс ID. Код подтверждает доступ к почте, но не парольный повторный вход в Яндекс ID.');
          const form = document.createElement('form'); form.className = 'ru-suspension-form';
          const select = document.createElement('select'); select.required = true; select.setAttribute('aria-label', 'Аккаунт');
          const prompt = node(document, 'option', '', 'Выберите аккаунт'); prompt.value = ''; prompt.disabled = true; prompt.selected = true; select.append(prompt);
          for (const target of targets) {
            const name = [target.first_name, target.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
            const option = node(document, 'option', '', `${name || 'Ученик'} · ${target.role === 'student' ? 'ученик' : 'Совет'}`);
            option.value = target.id; select.append(option);
          }
          const duration = document.createElement('select'); duration.required = true; duration.setAttribute('aria-label', 'Срок ограничения');
          for (const [hours, label] of [[24, '24 часа'], [72, '3 дня'], [168, '7 дней']]) { const option = node(document, 'option', '', label); option.value = String(hours); duration.append(option); }
          const reason = document.createElement('textarea'); reason.required = true; reason.minLength = 15; reason.maxLength = 400; reason.placeholder = 'Причина (15–400 символов, без контактов)';
          const issueSuspension = async () => {
            if (!UUID.test(select.value || '') || reason.value.trim().length < 15 || reason.value.trim().length > 400) { status.textContent = 'Выберите аккаунт и укажите причину длиной 15–400 символов.'; return; }
            await patch(`/api/v1/suspensions/${select.value}`, { action: 'issue', duration_hours: Number(duration.value), reason: reason.value.trim() });
          };
          const submit = actionButton(document, 'Установить ограничение', issueSuspension);
          form.addEventListener('submit', async event => { event.preventDefault(); await issueSuspension(); });
          form.append(select, duration, reason, submit); panel.append(note, form); queue.append(panel);
        }
      }
      if (me.profile.role === 'school_admin' && roleManagementTargets.length) {
        const panel = node(document, 'section', 'ru-moderation-card');
        panel.append(node(document, 'h3', '', 'Управление полномочиями школы'));
        panel.append(node(document, 'p', '', 'После подтверждения полномочий аккаунт останется активным.'));
        for (const target of roleManagementTargets) {
          const row = node(document, 'div', 'ru-moderation-actions');
          const name = [target.first_name, target.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
          row.append(node(document, 'span', '', `${name || 'Пользователь'} · ${target.role === 'school_admin' ? 'администратор школы' : 'участник Совета'}${target.class_name ? ` · ${target.class_name}` : ''}`));
          row.append(actionButton(document, 'Снять роль', async () => {
            const confirmAction = document.defaultView?.confirm || globalThis.confirm;
            if (!confirmAction || !confirmAction(`Снять роль у ${name || 'пользователя'}? Аккаунт останется активным.`)) return;
            await patch(`/api/v1/role-management/${target.id}`, { action: 'revoke' });
          }));
          panel.append(row);
        }
        queue.append(panel);
      }
      const renderSafetyPanel = () => {
        if (me.profile.role !== 'school_admin') return;
        const safetyPanel = node(document, 'section', 'ru-moderation-card');
        safetyPanel.append(node(document, 'h3', '', 'Сигналы безопасности'));
        safetyPanel.append(node(document, 'p', '', 'Сводка неполная: система записывает локально обнаруженные угрозы и дискриминацию; другие сигналы пока не перенесены.'));
        if (!safetyReportsAvailable) safetyPanel.append(node(document, 'p', '', 'Не удалось загрузить сохранённые сигналы.'));
        const categoryNames = { targeted_harassment: 'Травля', hate_or_discrimination: 'Ненависть или дискриминация',
          threat_or_intimidation: 'Угроза или запугивание', negative_personal_call: 'Оскорбление',
          spam_or_repeated_abuse: 'Спам или повторное нарушение', unsafe_image: 'Небезопасное изображение',
          personal_data_in_image: 'Личные данные на изображении', unclear_safety_signal: 'Другой сигнал безопасности' };
        const sourceNames = { message: 'сообщение', idea: 'идея', listing: 'объявление', image: 'изображение' };
        for (const report of safetyReports) {
          const card = node(document, 'article', 'ru-moderation-card');
          card.append(node(document, 'h4', '', `${report.severity === 'high' ? 'Высокая' : 'Средняя'} важность · ${categoryNames[report.category]}`));
          card.append(node(document, 'p', '', `Источник: ${sourceNames[report.source_kind]} · Повторений: ${report.occurrences}`));
          const personName = person => person ? [person.first_name, person.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ') || `Аккаунт ${person.account_code || ''}` : 'Неизвестно';
          card.append(node(document, 'p', '', `Участник: ${personName(report.actor)} · Затронут: ${personName(report.target)}`));
          if (typeof report.evidence_excerpt === 'string') card.append(node(document, 'p', '', `Фрагмент: ${report.evidence_excerpt}`));
          if (typeof report.source_origin === 'string') card.append(node(document, 'p', '', `Раздел: ${report.source_origin}`));
          if (typeof report.last_seen === 'string') card.append(node(document, 'p', '', `Последний сигнал: ${new Date(report.last_seen).toLocaleString('ru-RU')}`));
          card.append(actionButton(document, 'Отметить просмотренным', () => patch('/api/v1/school/admin/safety-reports', {
            fingerprint: report.fingerprint, category: report.category, source_kind: report.source_kind,
          })));
          safetyPanel.append(card);
        }
        queue.append(safetyPanel);
      };
      const renderPendingMessagesPanel = () => {
        if (me.profile.role !== 'school_admin') return;
        const reviewPanel = node(document, 'section', 'ru-moderation-card');
        reviewPanel.append(node(document, 'h3', '', 'Сообщения на школьной проверке'));
        if (!pendingMessagesAvailable) reviewPanel.append(node(document, 'p', '', 'Не удалось загрузить сообщения на проверку.'));
        if (!pendingMessages.length && pendingMessagesAvailable) reviewPanel.append(node(document, 'p', '', 'Сообщений на проверке нет.'));
        for (const message of pendingMessages) {
          const card = node(document, 'article', 'ru-moderation-card');
          card.append(node(document, 'p', '', `Отправитель · ${message.sender_id.slice(-6).toUpperCase()}`));
          card.append(node(document, 'p', '', message.body));
          if (typeof message.created_at === 'string') card.append(node(document, 'p', '', `Получено: ${new Date(message.created_at).toLocaleString('ru-RU')}`));
          const actions = node(document, 'div', 'ru-moderation-actions');
          actions.append(actionButton(document, 'Одобрить и доставить', () => patch(`/api/v1/messages/moderation/${message.id}`, { decision: 'approve' })));
          actions.append(actionButton(document, 'Отклонить', () => patch(`/api/v1/messages/moderation/${message.id}`, { decision: 'reject' })));
          card.append(actions); reviewPanel.append(card);
        }
        queue.append(reviewPanel);
      };
      const renderSchoolOverviewPanel = () => {
        if (me.profile.role !== 'school_admin') return;
        const overview = node(document, 'section', 'ru-moderation-card');
        overview.append(node(document, 'h3', '', 'Обзор школы'));
        if (!schoolOverviewAvailable) {
          overview.append(node(document, 'p', '', 'Не удалось загрузить обзор школы. Повторите попытку позже.'));
          queue.append(overview);
          return;
        }
        const users = schoolOverviewResult.users.filter(item => item && UUID.test(item.id || '')
          && ['student', 'council_member', 'school_admin'].includes(item.role));
        const listings = schoolOverviewResult.listings.filter(item => item && UUID.test(item.id || '')
          && ['active', 'pending', 'rejected', 'removed'].includes(item.status));
        const deletionRequests = schoolOverviewResult.deletion_requests.filter(item => item && UUID.test(item.id || '')
          && ['student', 'council_member'].includes(item.target_role) && ['pending', 'processing'].includes(item.status));
        const suspensions = schoolOverviewResult.suspensions.filter(item => item && UUID.test(item.target_id || '')
          && ['student', 'council_member'].includes(item.target_role));
        overview.append(node(document, 'p', '', `В выборке: активных профилей — ${users.length}, активных публикаций — ${listings.filter(item => item.status === 'active').length}, ожидают проверки — ${listings.filter(item => item.status === 'pending').length}, заявок на удаление — ${deletionRequests.length}, ограничений — ${suspensions.length}.`));
        overview.append(node(document, 'p', '', 'Список ограничен последними 100 профилями и публикациями, 50 заявками и 100 ограничениями.'));
        const accounts = node(document, 'section', 'ru-school-account-list');
        accounts.append(node(document, 'h4', '', 'Аккаунты школы'));
        accounts.append(node(document, 'p', 'ru-note', 'Список показывает до 100 активных профилей. Удалить можно аккаунт ученика или Совета; перед удалением нужно подтвердить действие через Яндекс ID.'));
        const roleNames = { student: 'Ученик', council_member: 'Участник Ученического совета', school_admin: 'Администратор школы' };
        for (const account of users) {
          const card = node(document, 'article', 'ru-school-account-card');
          const name = [account.first_name, account.last_name]
            .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()).join(' ') || 'Аккаунт участника';
          card.append(node(document, 'b', '', name));
          card.append(node(document, 'p', '', `Класс: ${typeof account.class_name === 'string' && account.class_name.trim() ? account.class_name.trim() : 'не указан'} · ${roleNames[account.role]} · аккаунт #${account.id.slice(-6).toUpperCase()}`));
          card.append(node(document, 'p', 'ru-note', `Публикаций в выборке: ${listings.filter(item => item.user_id === account.id).length}.`));
          if (['student', 'council_member'].includes(account.role)
              && account.id.toLowerCase() !== String(me.profile.id || '').toLowerCase()) {
            card.append(actionButton(document, 'Удалить аккаунт', () => deleteSchoolAccount(account)));
          }
          accounts.append(card);
        }
        if (!users.length) accounts.append(node(document, 'p', '', 'Активные профили школы не найдены.'));
        overview.append(accounts);
        const actionNames = { role_revoked: 'Снята школьная роль', account_deleted: 'Удалён аккаунт по решению школы',
          account_deleted_by_admin: 'Удалён аккаунт администратором', listing_deleted: 'Удалено объявление',
          issued: 'Выдано временное ограничение', lifted: 'Снято временное ограничение',
          idea_text_approved: 'Одобрен текст школьной идеи', idea_text_rejected: 'Отклонён текст школьной идеи',
          idea_workflow_in_progress: 'Идея взята в работу', idea_workflow_done: 'Идея отмечена выполненной', idea_workflow_rejected: 'Идея отклонена',
          message_approved: 'Одобрена доставка сообщения', message_rejected: 'Отклонено сообщение' };
        const audit = schoolOverviewResult.audit.filter(item => item && typeof actionNames[item.action] === 'string'
          && typeof item.created_at === 'string' && Number.isFinite(Date.parse(item.created_at))).slice(0, 5);
        overview.append(node(document, 'h4', '', 'Последние действия школы'));
        if (!audit.length) overview.append(node(document, 'p', '', 'Записанных действий пока нет.'));
        for (const item of audit) overview.append(node(document, 'p', '', `${actionNames[item.action]} · ${new Date(item.created_at).toLocaleString('ru-RU')}`));
        queue.append(overview);
      };
      if (result.listings.length === 0 && applications.length === 0 && profileRequests.length === 0 && roleRequests.length === 0 && suspensions.length === 0 && roleManagementTargets.length === 0 && safetyReports.length === 0 && pendingMessages.length === 0 && schoolIdeas.length === 0 && workflowIdeas.length === 0) {
        renderPendingMessagesPanel();
        renderSchoolIdeasPanel();
        renderIdeaWorkflowPanel();
        renderSafetyPanel();
        renderSchoolOverviewPanel();
        if (me.profile.role === 'school_admin') await renderSchoolAgentDashboard(options);
        status.textContent = !suspensionsAvailable ? 'Очереди проверки пусты, но не удалось загрузить действующие ограничения. Обновите список позже.'
          : !pendingMessagesAvailable ? 'Очереди проверки пусты, но не удалось загрузить сообщения на ручную проверку.'
            : !safetyReportsAvailable ? 'Очереди школьной проверки пусты, но не удалось загрузить сигналы безопасности.'
                : !schoolIdeasAvailable ? 'Очереди проверки пусты, но не удалось загрузить школьные идеи.'
              : !ideaWorkflowAvailable ? 'Не удалось загрузить школьные идеи.'
                : 'Очереди школьной проверки пусты.';
        return;
      }
      status.textContent = `Очереди: объявлений — ${result.listings.length}, заявок на мероприятия — ${applications.length}, школьных профилей — ${profileRequests.length}, запросов ролей — ${roleRequests.length}, действующих ограничений — ${suspensions.length}, сообщений на проверке — ${pendingMessages.length}, школьных идей — ${schoolIdeas.length}, статусов школьных идей — ${workflowIdeas.length}, сигналов безопасности — ${safetyReports.length}.${suspensionsAvailable && pendingMessagesAvailable && safetyReportsAvailable && schoolIdeasAvailable && ideaWorkflowAvailable ? '' : ' Не все очереди удалось загрузить; список неполный.'}`;
      for (const listing of result.listings) {
        if (!listing || !UUID.test(listing.id) || typeof listing.title !== 'string' || typeof listing.description !== 'string') continue;
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', listing.title));
        card.append(node(document, 'p', '', `${listing.category || ''} · ${listing.price_text || 'Бесплатно'}`));
        card.append(node(document, 'p', '', listing.description));
        if (listing.photo_url === `/api/v1/listings/${listing.id}/photo` && ['pending', 'approved'].includes(listing.photo_status)) {
          const photo = document.createElement('img');
          photo.className = 'ru-listing-photo';
          photo.src = listing.photo_url;
          photo.alt = `Фото на проверке: ${listing.title}`;
          photo.loading = 'lazy';
          photo.referrerPolicy = 'no-referrer';
          card.append(photo);
        }
        const actions = node(document, 'div', 'ru-moderation-actions');
        if (listing.photo_status === 'pending') {
          actions.append(actionButton(document, 'Одобрить фото', () => decide(`/api/v1/listings/${listing.id}/photo`, 'approve')));
          actions.append(actionButton(document, 'Отклонить фото', () => decide(`/api/v1/listings/${listing.id}/photo`, 'reject')));
        }
        if (['none', 'approved'].includes(listing.photo_status)) {
          actions.append(actionButton(document, 'Опубликовать', () => decide(`/api/v1/listings/${listing.id}/moderation`, 'approve')));
        }
        actions.append(actionButton(document, 'Отклонить объявление', () => decide(`/api/v1/listings/${listing.id}/moderation`, 'reject')));
        card.append(actions);
        queue.append(card);
      }
      for (const application of applications) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', application.event_title));
        const name = [application.first_name, application.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
        const personType = application.person_type === 'school_staff' ? 'сотрудник школы'
          : application.person_type === 'parent' ? 'родитель' : 'ученик';
        const details = [personType, application.class_name, application.staff_position].filter(value => typeof value === 'string' && value.trim()).join(' · ');
        card.append(node(document, 'p', '', `Заявка: ${name || personType} · ${details}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        const path = `/api/v1/listings/${application.event_id}/registrations/${application.user_id}`;
        actions.append(actionButton(document, 'Подтвердить заявку', () => decide(path, 'approve')));
        actions.append(actionButton(document, 'Отклонить заявку', () => decide(path, 'reject')));
        card.append(actions);
        queue.append(card);
      }
      for (const request of profileRequests) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', `${request.first_name} ${request.last_name}`));
        const typeName = request.person_type === 'school_staff' ? 'сотрудник школы'
          : request.person_type === 'parent' ? 'родитель' : 'ученик';
        card.append(node(document, 'p', '', `Заявка: ${typeName}${request.class_name ? ` · класс ${request.class_name}` : ''}${request.staff_position ? ` · ${request.staff_position}` : ''}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        const path = `/api/v1/profile-requests/${request.request_id}`;
        actions.append(actionButton(document, 'Одобрить профиль', () => decide(path, 'approve')));
        actions.append(actionButton(document, 'Отклонить заявку', () => decide(path, 'reject')));
        card.append(actions); queue.append(card);
      }
      if (me.profile.role === 'school_admin') {
        const panel = node(document, 'section', 'ru-moderation-card');
        panel.append(node(document, 'h3', '', 'Проверка сотрудников школы'));
        if (!staffVerificationsAvailable) panel.append(node(document, 'p', '', 'Не удалось загрузить заявки сотрудников.'));
        else if (!staffVerifications.length) panel.append(node(document, 'p', '', 'Новых заявок на подтверждение должности нет.'));
        for (const request of staffVerifications) {
          const row = node(document, 'article', 'ru-moderation-card');
          row.append(node(document, 'p', '', `${request.first_name} ${request.last_name} · ${request.staff_position}`));
          const actions = node(document, 'div', 'ru-moderation-actions');
          actions.append(actionButton(document, 'Подтвердить должность', () => patch(`/api/v1/staff-verifications/${request.user_id}`, { decision: 'approved' })));
          actions.append(actionButton(document, 'Отклонить', () => patch(`/api/v1/staff-verifications/${request.user_id}`, { decision: 'rejected' })));
          row.append(actions); panel.append(row);
        }
        queue.append(panel);
      }
      for (const request of roleRequests) {
        const card = node(document, 'article', 'ru-moderation-card');
        const roleName = request.requested_role === 'school_admin' ? 'Администратор школы' : 'Участник Ученического совета';
        card.append(node(document, 'h3', '', `Запрос: ${roleName}`));
        const applicant = request.applicant_name || '';
        const classLabel = request.class_name ? ` · класс ${request.class_name}` : '';
        card.append(node(document, 'p', '', `${applicant ? `${applicant}${classLabel} · аккаунт ` : 'Аккаунт '}#${request.account_code || '—'}`));
        card.append(node(document, 'p', '', request.status === 'reviewing' ? 'Взято на рассмотрение' : 'Ожидает рассмотрения'));
        const actions = node(document, 'div', 'ru-moderation-actions');
        const path = `/api/v1/role-requests/${request.request_id}`;
        if (request.status === 'pending') actions.append(actionButton(document, 'Начать рассмотрение', () => patch(path, { action: 'start_review' })));
        if (request.status === 'reviewing' && request.review_started_by_me === true) {
          actions.append(actionButton(document, 'Одобрить роль', () => patch(path, { decision: 'approve' })));
          actions.append(actionButton(document, 'Отклонить', () => patch(path, { decision: 'reject' })));
        }
        card.append(actions); queue.append(card);
      }
      for (const suspension of suspensions) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', 'Временное ограничение аккаунта'));
        card.append(node(document, 'p', '', `ID аккаунта: ${suspension.target_id}`));
        card.append(node(document, 'p', '', `Причина: ${suspension.reason}`));
        card.append(node(document, 'p', '', `Действует до: ${new Date(suspension.expires_at).toLocaleString('ru-RU')}`));
        const lift = actionButton(document, 'Снять ограничение', () => patch(`/api/v1/suspensions/${suspension.target_id}`, { action: 'lift' }));
        card.append(lift);
        queue.append(card);
      }
      renderPendingMessagesPanel();
      renderSchoolIdeasPanel();
      renderIdeaWorkflowPanel();
      renderSafetyPanel();
      renderSchoolOverviewPanel();
    } catch { status.textContent = 'Не удалось загрузить очередь. Проверьте подключение и попробуйте позже.'; }
  }

  async function decide(path, decision) {
    status.textContent = 'Сохраняем решение…';
    try {
      const response = await fetchImpl(path, { method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ decision }) });
      if (!response.ok) throw new Error('decision_failed');
      await load();
    } catch { status.textContent = 'Не удалось сохранить решение. Очередь не обновлена.'; }
  }

  async function renderSchoolAgentDashboard(options) {
    let response; let result;
    try { response = await fetchImpl('/api/v1/school/admin/agent-dashboard', options); result = await json(response); } catch { return; }
    if (!response.ok || !result?.ok) return;
    const report = result.report;
    const ideas = Array.isArray(result.ideas) ? result.ideas.filter(item => item && /^[a-f0-9]{64}$/.test(item.id || '')
      && typeof item.title === 'string' && typeof item.summary === 'string' && typeof item.evidence_summary === 'string') : [];
    const card = node(document, 'section', 'ru-moderation-card');
    card.append(node(document, 'h3', '', 'Ежедневная сводка и предложения помощников'));
    if (report && typeof report.summary === 'string') {
      card.append(node(document, 'p', '', report.summary));
      if (typeof report.generated_at === 'string') card.append(node(document, 'p', '', `Обновлено: ${new Date(report.generated_at).toLocaleString('ru-RU')}`));
    } else card.append(node(document, 'p', '', 'Сводка появится после первого запуска фонового задания.'));
    if (!ideas.length) card.append(node(document, 'p', '', 'Открытых предложений помощников нет.'));
    for (const idea of ideas) {
      const item = node(document, 'article', 'ru-moderation-card');
      item.append(node(document, 'h4', '', idea.title), node(document, 'p', '', idea.summary), node(document, 'p', '', `Основание: ${idea.evidence_summary}`));
      const actions = node(document, 'div', 'ru-moderation-actions');
      actions.append(actionButton(document, 'Принять к работе', () => patch(`/api/v1/school/admin/agent-ideas/${idea.id}`, { decision: 'approve' })));
      actions.append(actionButton(document, 'Отклонить', () => patch(`/api/v1/school/admin/agent-ideas/${idea.id}`, { decision: 'reject' })));
      item.append(actions); card.append(item);
    }
    queue.append(card);
  }

  async function patch(path, body) {
    status.textContent = 'Сохраняем решение…';
    try {
      const needsFreshConfirmation = path.startsWith('/api/v1/suspensions/')
        || path.startsWith('/api/v1/role-management/');
      const request = needsFreshConfirmation ? requestWithEmailStepUp : async options => {
        const response = await options.fetchImpl(options.url, options.init);
        return { response, result: await json(response), stepUpError: null };
      };
      const { response, result, stepUpError } = await request({ fetchImpl, promptImpl, url: path,
        init: { method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) } });
      if (!response.ok) {
        if (result?.error === 'fresh_authentication_required') {
          status.textContent = stepUpError === 'code_entry_cancelled' ? 'Подтверждение отменено. Изменений нет.'
            : 'Не удалось подтвердить административное действие по почте. Изменений нет.';
          return;
        }
        if (result?.error === 'already_suspended') { status.textContent = 'У этого аккаунта уже есть действующее ограничение.'; return; }
        throw new Error('decision_failed');
      }
      const agentIdeaDecision = path.startsWith('/api/v1/school/admin/agent-ideas/') && ['approve', 'reject'].includes(body.decision);
      await load();
      if (agentIdeaDecision) status.textContent = `Предложение помощника ${body.decision === 'approve' ? 'принято к работе' : 'отклонено'}.`;
    } catch { status.textContent = 'Не удалось сохранить решение. Очередь не обновлена.'; }
  }

  async function removeSchoolIdea(idea) {
    if (!confirmImpl(`Удалить идею школы «${idea.text.slice(0, 80)}»?`)) return;
    const body = {};
    if (me.profile.role === 'school_admin' && !idea.is_own) {
      const confirmation = 'УДАЛИТЬ ИДЕЮ ШКОЛЫ';
      if (promptImpl(`Для окончательного удаления введите точно: ${confirmation}`) !== confirmation) {
        status.textContent = 'Удаление отменено: фраза подтверждения не совпала.'; return;
      }
      body.confirmation = confirmation;
    }
    status.textContent = 'Проверяем возможность безопасного удаления идеи…';
    try {
      const response = await fetchImpl(`/api/v1/ideas/${idea.id}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}) });
      const result = await json(response);
      if (!response.ok || !result?.ok) throw new Error('idea_delete_failed');
      await load();
      if (result.image_cleanup === 'queued') status.textContent = 'Идея удалена; связанные фотографии поставлены в очередь очистки.';
    } catch { status.textContent = 'Не удалось удалить идею. Очередь не обновлена.'; }
  }

  await load();
  await loadDeletionRequests();

  async function loadDeletionRequests() {
    if (me.profile.role === 'council_member') {
      const section = document.getElementById('ruDeletionRequestSubmit');
      const targetsSelect = document.getElementById('ruDeletionTarget');
      const reasonCode = document.getElementById('ruDeletionReasonCode');
      const reason = document.getElementById('ruDeletionReason');
      const form = document.getElementById('ruDeletionRequestForm');
      const requestStatus = document.getElementById('ruDeletionRequestStatus');
      const ownRequests = document.getElementById('ruDeletionOwnRequests');
      if (!section || !targetsSelect || !reasonCode || !reason || !form || !requestStatus || !ownRequests) return;
      section.hidden = false;
      try {
        const options = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
        const [targetResponse, ownResponse] = await Promise.all([
          fetchImpl('/api/v1/deletion-requests/targets', options),
          fetchImpl('/api/v1/deletion-requests', options),
        ]);
        const [targetResult, ownResult] = await Promise.all([json(targetResponse), json(ownResponse)]);
        if (!targetResponse.ok || !targetResult?.ok || !Array.isArray(targetResult.targets)
          || !ownResponse.ok || !ownResult?.ok || !Array.isArray(ownResult.requests)) throw new Error('deletion_requests_unavailable');
        targetsSelect.replaceChildren();
        const prompt = node(document, 'option', '', 'Выберите аккаунт'); prompt.value = ''; prompt.disabled = true; prompt.selected = true;
        targetsSelect.append(prompt);
        for (const target of targetResult.targets) {
          if (!target || !UUID.test(target.id) || !['student', 'council_member'].includes(target.role)) continue;
          const label = [target.first_name, target.last_name].filter(value => typeof value === 'string' && value.trim()).join(' ');
          const option = node(document, 'option', '', `${label || 'Ученик'} · ${target.role === 'student' ? 'ученик' : 'Совет'}`);
          option.value = target.id;
          targetsSelect.append(option);
        }
        renderOwnDeletionRequests(document, ownRequests, ownResult.requests);
        requestStatus.textContent = targetResult.targets.length ? '' : 'В школе нет доступных аккаунтов для обращения.';
      } catch {
        requestStatus.textContent = 'Не удалось загрузить список аккаунтов и обращений. Попробуйте позже.';
      }
      if (!form.dataset?.bound) {
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (!UUID.test(targetsSelect.value || '') || reason.value.trim().length < 15 || reason.value.trim().length > 500) {
            requestStatus.textContent = 'Выберите аккаунт и укажите объяснение длиной 15–500 символов.';
            return;
          }
          requestStatus.textContent = 'Отправляем обращение…';
          try {
            const response = await fetchImpl('/api/v1/deletion-requests', {
              method: 'POST', credentials: 'same-origin', cache: 'no-store',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ target_id: targetsSelect.value, reason_code: reasonCode.value, reason: reason.value.trim() }),
            });
            const result = await json(response);
            if (!response.ok || !result?.ok) throw new Error('request_failed');
            requestStatus.textContent = result.already_exists
              ? 'По этому аккаунту уже есть открытое обращение.'
              : 'Обращение передано администратору школы. Аккаунт не удалён.';
            if (!result.already_exists) reason.value = '';
            const historyResponse = await fetchImpl('/api/v1/deletion-requests', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
            const history = await json(historyResponse);
            if (historyResponse.ok && history?.ok && Array.isArray(history.requests)) renderOwnDeletionRequests(document, ownRequests, history.requests);
          } catch { requestStatus.textContent = 'Не удалось отправить обращение. Повторите попытку позже.'; }
        });
        if (form.dataset) form.dataset.bound = 'true';
      }
      return;
    }

    if (me.profile.role !== 'school_admin') return;
    const section = document.getElementById('ruDeletionRequestReview');
    const requestStatus = document.getElementById('ruDeletionReviewStatus');
    const reviewQueue = document.getElementById('ruDeletionReviewQueue');
    if (!section || !requestStatus || !reviewQueue) return;
    section.hidden = false;
    try {
      const response = await fetchImpl('/api/v1/deletion-requests/review', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      const result = await json(response);
      if (!response.ok || !result?.ok || !Array.isArray(result.requests)) throw new Error('deletion_review_unavailable');
      reviewQueue.replaceChildren();
      const requests = result.requests.filter(item => item && UUID.test(item.request_id)
        && ['student', 'council_member'].includes(item.target_role) && typeof item.reason === 'string'
        && ['rules_violation', 'harassment', 'fake_account', 'spam', 'other'].includes(item.reason_code));
      requestStatus.textContent = requests.length ? `Открытых обращений: ${requests.length}.` : 'Открытых обращений нет.';
      for (const item of requests) {
        const card = node(document, 'article', 'ru-moderation-card');
        card.append(node(document, 'h3', '', 'Обращение по аккаунту'));
        card.append(node(document, 'p', '', `ID аккаунта: ${item.target_id}`));
        card.append(node(document, 'p', '', `Причина: ${item.reason}`));
        const actions = node(document, 'div', 'ru-moderation-actions');
        actions.append(actionButton(document, 'Отклонить обращение', async () => {
          requestStatus.textContent = 'Закрываем обращение…';
          try {
            const decision = await fetchImpl(`/api/v1/deletion-requests/${item.request_id}`, {
              method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ decision: 'reject' }),
            });
            if (!decision.ok) throw new Error('decision_failed');
            await loadDeletionRequests();
          } catch { requestStatus.textContent = 'Не удалось отклонить обращение. Очередь не обновлена.'; }
        }));
        actions.append(actionButton(document, 'Одобрить и удалить аккаунт', async () => {
          const confirmAction = document.defaultView?.confirm || globalThis.confirm;
          const promptAction = document.defaultView?.prompt || globalThis.prompt;
          if (typeof confirmAction !== 'function' || typeof promptAction !== 'function') {
            requestStatus.textContent = 'Браузер не поддерживает подтверждение удаления. Обращение не изменено.';
            return;
          }
          if (!confirmAction('Подтвердите окончательное удаление аккаунта ученика или участника Совета и связанных данных этой школы.')) return;
          if (promptAction('Для продолжения введите точно: УДАЛИТЬ АККАУНТ УЧАСТНИКА') !== 'УДАЛИТЬ АККАУНТ УЧАСТНИКА') {
            requestStatus.textContent = 'Фраза не совпала. Обращение и аккаунт не изменены.';
            return;
          }
          requestStatus.textContent = 'Проверяем возможность безопасного удаления аккаунта…';
          try {
            const { response: decision, result: decided, stepUpError } = await requestWithEmailStepUp({ fetchImpl, promptImpl,
              url: `/api/v1/deletion-requests/${item.request_id}`, init: {
              method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ decision: 'approve', confirmation: 'УДАЛИТЬ АККАУНТ УЧАСТНИКА' }),
            } });
            if (!decision.ok || !decided?.ok) {
              if (decided?.error === 'fresh_authentication_required') {
                requestStatus.textContent = stepUpError === 'code_entry_cancelled' ? 'Подтверждение отменено. Обращение осталось открытым.'
                  : 'Не удалось подтвердить действие по почте. Обращение осталось открытым.';
                return;
              }
              throw new Error('decision_failed');
            }
            requestStatus.textContent = 'Аккаунт и связанные данные удалены. Обновляем очередь…';
            await loadDeletionRequests();
          } catch { requestStatus.textContent = 'Не удалось удалить аккаунт. Обращение должно остаться в очереди; обновите её перед повтором.'; }
        }));
        card.append(actions); reviewQueue.append(card);
      }
    } catch { requestStatus.textContent = 'Не удалось загрузить обращения этой школы.'; }
  }
}

function renderOwnDeletionRequests(document, container, requests) {
  container.replaceChildren();
  if (!requests.length) { container.append(node(document, 'p', 'ru-note', 'Обращений пока нет.')); return; }
  for (const request of requests.slice(0, 10)) {
    if (!request || !UUID.test(request.request_id) || typeof request.status !== 'string' || typeof request.reason !== 'string') continue;
    const card = node(document, 'article', 'ru-moderation-card');
    const status = request.status === 'pending' ? 'ожидает рассмотрения' : request.status === 'rejected' ? 'отклонено' : request.status;
    card.append(node(document, 'p', '', `Обращение: ${status}`));
    card.append(node(document, 'p', '', request.reason));
    if (request.review_note) card.append(node(document, 'p', 'ru-note', `Комментарий: ${request.review_note}`));
    container.append(card);
  }
}

function actionButton(document, label, handler) {
  const button = node(document, 'button', 'ru-button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

if (globalThis.document) void initializeListingModeration();
