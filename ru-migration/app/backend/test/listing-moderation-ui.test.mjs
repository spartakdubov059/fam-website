import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeListingModeration } from '../../web/listing-moderation.js';

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.hidden = false; this.dataset = {}; this.value = ''; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
}

function fixture() {
  const panel = new FakeNode('section');
  panel.hidden = true;
  const status = new FakeNode('p');
  const queue = new FakeNode('div');
  const deletionFormSection = new FakeNode('section'); deletionFormSection.hidden = true;
  const deletionForm = new FakeNode('form');
  const deletionTarget = new FakeNode('select');
  const deletionReasonCode = new FakeNode('select'); deletionReasonCode.value = 'spam';
  const deletionReason = new FakeNode('textarea');
  const deletionStatus = new FakeNode('p');
  const ownDeletionRequests = new FakeNode('div');
  const deletionReviewSection = new FakeNode('section'); deletionReviewSection.hidden = true;
  const deletionReviewStatus = new FakeNode('p');
  const deletionReviewQueue = new FakeNode('div');
  const elements = { ruModeration: panel, ruModerationStatus: status, ruModerationQueue: queue,
    ruDeletionRequestSubmit: deletionFormSection, ruDeletionRequestForm: deletionForm, ruDeletionTarget: deletionTarget,
    ruDeletionReasonCode: deletionReasonCode, ruDeletionReason: deletionReason, ruDeletionRequestStatus: deletionStatus,
    ruDeletionOwnRequests: ownDeletionRequests, ruDeletionRequestReview: deletionReviewSection,
    ruDeletionReviewStatus: deletionReviewStatus, ruDeletionReviewQueue: deletionReviewQueue };
  return { document: { getElementById: id => elements[id], createElement: tag => new FakeNode(tag) }, panel, status, queue };
}

test('school moderators review same-school pending photos and publish only after photo approval', async () => {
  const f = fixture();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls = [];
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'council_member' } }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/listings/moderation' && calls.filter(call => call.url === url).length === 1) {
      return { ok: true, json: async () => ({ ok: true, listings: [{ id, title: '<script>unsafe</script>', description: 'Текст', category: 'Учёба', photo_status: 'pending', photo_url: `/api/v1/listings/${id}/photo` }] }) };
    }
    if (url === `/api/v1/listings/${id}/photo`) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ ok: true, listings: [] }) };
  } });
  assert.equal(f.panel.hidden, false);
  const card = f.queue.children[0];
  assert.equal(card.children[0].textContent, '<script>unsafe</script>');
  assert.equal(card.children[3].tagName, 'img');
  const actions = card.children.at(-1).children;
  assert.deepEqual(actions.map(button => button.textContent), ['Одобрить фото', 'Отклонить фото', 'Отклонить объявление']);
  await actions[0].listeners.click();
  const decision = calls.find(call => call.url === `/api/v1/listings/${id}/photo`);
  assert.equal(decision.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(decision.init.body), { decision: 'approve' });
  assert.equal(f.status.textContent, 'Очереди школьной проверки пусты.');
});

test('student profiles do not receive the school moderation queue', async () => {
  const f = fixture();
  const routes = [];
  await initializeListingModeration({ ...f, fetchImpl: async url => {
    routes.push(url);
    return { ok: true, json: async () => ({ ok: true, profile: { role: 'student' } }) };
  } });
  assert.deepEqual(routes, ['/api/v1/me']);
  assert.equal(f.panel.hidden, true);
});

test('school admins see active suspensions returned by the same-school endpoint as text', async () => {
  const f = fixture(); const calls = [];
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/suspensions') return { ok: true, json: async () => ({ ok: true, suspensions: [{ target_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target_role: 'student', reason: '<script>unsafe</script>', expires_at: '2099-01-01T00:00:00Z' }] }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review' || url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    throw new Error(`unexpected route ${url}`);
  } });
  assert.ok(calls.some(call => call.url === '/api/v1/suspensions' && call.init.credentials === 'same-origin'));
  const card = f.queue.children[0];
  assert.equal(card.children[1].textContent, 'ID аккаунта: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(card.children[2].textContent, 'Причина: <script>unsafe</script>');
  assert.equal(card.children[2].tagName, 'p');
});

test('school admins can issue and lift short account restrictions with safe text and fresh Yandex confirmation', async () => {
  const f = fixture(); const calls = [];
  const target = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'admin-a', role: 'school_admin' } }) };
    if (url === '/api/v1/suspensions') return { ok: true, json: async () => ({ ok: true, suspensions: [{ target_id: target, target_role: 'student', reason: 'Repeated disruption', expires_at: '2099-01-01T00:00:00Z' }] }) };
    if (url === '/api/v1/suspensions/targets') return { ok: true, json: async () => ({ ok: true, targets: [{ id: target, role: 'student', first_name: '<script>', last_name: 'Имя' }] }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review' || url === '/api/v1/profile-requests/review' || url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, applications: [], requests: [] }) };
    if (url === `/api/v1/suspensions/${target}` && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (body.action === 'issue') return { ok: false, json: async () => ({ ok: false, error: 'fresh_auth_required' }) };
      if (body.action === 'lift') return { ok: true, json: async () => ({ ok: true, status: 'lifted' }) };
    }
    throw new Error(`unexpected route ${url}`);
  } });
  const panel = f.queue.children[0];
  const form = panel.children[2];
  const [targetSelect, duration, reason, submit] = form.children;
  assert.equal(targetSelect.children[1].textContent, '<script> Имя · ученик', 'names are rendered as text');
  targetSelect.value = target; duration.value = '72'; reason.value = 'Repeatedly disrupted the shared school board.';
  await form.listeners.submit({ preventDefault() {} });
  const issue = calls.find(call => call.init.method === 'PATCH' && JSON.parse(call.init.body).action === 'issue');
  assert.equal(issue.url, `/api/v1/suspensions/${target}`);
  assert.deepEqual(JSON.parse(issue.init.body), { action: 'issue', duration_hours: 72, reason: reason.value });
  assert.equal(f.status.children.find(child => child.href)?.href, '/auth/yandex/start?reauth=1', JSON.stringify(f.status.children));
  const activeCard = f.queue.children.find(card => card.children.some(child => child.textContent?.startsWith('Причина:')));
  const lift = activeCard.children.at(-1);
  await lift.listeners.click();
  const liftCall = calls.find(call => call.init.method === 'PATCH' && JSON.parse(call.init.body).action === 'lift');
  assert.equal(liftCall.url, `/api/v1/suspensions/${target}`);
});

test('school admins are told when suspension status could not be loaded instead of seeing a false empty result', async () => {
  const f = fixture();
  await initializeListingModeration({ ...f, fetchImpl: async url => {
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/suspensions') return { ok: false, json: async () => ({ ok: false }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review' || url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    throw new Error(`unexpected route ${url}`);
  } });
  assert.match(f.status.textContent, /не удалось загрузить действующие ограничения/);
});

test('staff can confirm or reject a pending event application using safe text rendering', async () => {
  const f = fixture();
  const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const calls = [];
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [{ event_id: eventId, event_title: '<b>Событие</b>', user_id: userId, status: 'pending', first_name: 'Аня', last_name: 'Иванова', class_name: '8А' }] }) };
    if (url === '/api/v1/profile-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    if (url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const card = f.queue.children[0];
  assert.equal(card.children[0].textContent, '<b>Событие</b>');
  assert.equal(card.children[1].textContent, 'Заявка: Аня Иванова · 8А');
  const actions = card.children[2].children;
  assert.deepEqual(actions.map(button => button.textContent), ['Подтвердить заявку', 'Отклонить заявку']);
  await actions[1].listeners.click();
  const decision = calls.find(call => call.url === `/api/v1/listings/${eventId}/registrations/${userId}`);
  assert.equal(decision.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(decision.init.body), { decision: 'reject' });
});

test('only school admins see profile access requests and approve them as students', async () => {
  const f = fixture();
  const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const calls = [];
  let pending = true;
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review') return { ok: true, json: async () => ({ ok: true, requests: pending ? [{ request_id: requestId, first_name: '<Аня>', last_name: 'Иванова', class_name: '8А' }] : [] }) };
    if (url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    if (url === `/api/v1/profile-requests/${requestId}`) { pending = false; return { ok: true, json: async () => ({ ok: true, status: 'approved' }) }; }
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const card = f.queue.children[0];
  assert.equal(card.children[0].textContent, '<Аня> Иванова');
  const actions = card.children.at(-1).children;
  assert.deepEqual(actions.map(button => button.textContent), ['Одобрить ученика', 'Отклонить заявку']);
  await actions[0].listeners.click();
  const patch = calls.find(call => call.url === `/api/v1/profile-requests/${requestId}`);
  assert.equal(patch.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(patch.init.body), { decision: 'approve' });
});

test('school role request review is claimed before only its reviewer can decide', async () => {
  const f = fixture(); const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; const calls = []; let state = 'pending';
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'admin-a', role: 'school_admin' } }) };
    if (url === '/api/v1/suspensions') return { ok: true, json: async () => ({ ok: true, suspensions: [] }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    if (url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: state === 'approved' ? [] : [{ request_id: id, requested_role: 'school_admin', status: state, review_started_by: state === 'reviewing' ? 'admin-a' : null }] }) };
    if (url === '/api/v1/school/admin/safety-reports') return { ok: true, json: async () => ({ ok: true, reports: [] }) };
    if (url === `/api/v1/role-requests/${id}`) { state = init.body.includes('start_review') ? 'reviewing' : 'approved'; return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  let card = f.queue.children[0];
  let actions = card.children.at(-1).children;
  assert.deepEqual(actions.map(button => button.textContent), ['Начать рассмотрение']);
  await actions[0].listeners.click();
  card = f.queue.children[0]; actions = card.children.at(-1).children;
  assert.deepEqual(actions.map(button => button.textContent), ['Одобрить роль', 'Отклонить']);
  await actions[0].listeners.click();
  const writes = calls.filter(call => call.url === `/api/v1/role-requests/${id}`);
  assert.deepEqual(writes.map(call => JSON.parse(call.init.body)), [{ action: 'start_review' }, { decision: 'approve' }]);
  assert.equal(f.status.textContent, 'Очереди школьной проверки пусты.');
});

test('school safety reports render as text and can be acknowledged through the RU API', async () => {
  const f = fixture(); const calls = [];
  const fingerprint = 'a'.repeat(64);
  let pending = true;
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/school/admin/safety-reports' && init.method === 'PATCH') { pending = false; return { ok: true, json: async () => ({ ok: true }) }; }
    if (url === '/api/v1/school/admin/safety-reports') return { ok: true, json: async () => ({ ok: true, reports: pending ? [{
      fingerprint, source_kind: 'message', category: 'targeted_harassment', severity: 'high', occurrences: 3,
      actor: { first_name: '<Аня>', last_name: 'Тест', account_code: 'AB12CD' }, target: null,
      evidence_excerpt: '<img src=x onerror=alert(1)>', source_origin: 'messages', last_seen: '2026-11-14T10:00:00Z',
    }] : [] }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review' || url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    if (url === '/api/v1/suspensions') return { ok: true, json: async () => ({ ok: true, suspensions: [] }) };
    return { ok: true, json: async () => ({ ok: true, targets: [] }) };
  } });
  const panel = f.queue.children.find(item => item.children[0]?.textContent === 'Сигналы безопасности');
  assert.ok(panel);
  assert.match(panel.children[1].textContent, /ещё не записывает новые сигналы/);
  const card = panel.children[2];
  assert.equal(card.children[2].textContent, 'Участник: <Аня> Тест · Затронут: Неизвестно');
  assert.equal(card.children[3].textContent, 'Фрагмент: <img src=x onerror=alert(1)>');
  assert.equal(card.children[3].tagName, 'p');
  await card.children.at(-1).listeners.click();
  const write = calls.find(call => call.url === '/api/v1/school/admin/safety-reports' && call.init.method === 'PATCH');
  assert.deepEqual(JSON.parse(write.init.body), { fingerprint, category: 'targeted_harassment', source_kind: 'message' });
  const refreshedPanel = f.queue.children.find(item => item.children[0]?.textContent === 'Сигналы безопасности');
  assert.equal(refreshedPanel.children.length, 2, 'acknowledged report is removed after reload');
});

test('council member submits a same-school removal request and sees personal history', async () => {
  const f = fixture(); const calls = [];
  const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let posted = false;
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { id: 'council-id', role: 'council_member' } }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/deletion-requests/targets') return { ok: true, json: async () => ({ ok: true, targets: [{ id: targetId, role: 'student', first_name: '<Аня>', last_name: 'Тест' }] }) };
    if (url === '/api/v1/deletion-requests' && init.method === 'GET') return { ok: true, json: async () => ({ ok: true, requests: posted ? [{ request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'pending', reason: '<script>тест</script>' }] : [] }) };
    if (url === '/api/v1/deletion-requests' && init.method === 'POST') { posted = true; return { ok: true, json: async () => ({ ok: true, request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) }; }
    throw new Error(`unexpected route ${url}`);
  } });
  assert.equal(f.document.getElementById('ruDeletionRequestSubmit').hidden, false);
  const select = f.document.getElementById('ruDeletionTarget');
  assert.equal(select.children[1].textContent, '<Аня> Тест · ученик');
  select.value = targetId;
  f.document.getElementById('ruDeletionReason').value = 'Несколько спам-публикаций в школьном чате.';
  await f.document.getElementById('ruDeletionRequestForm').listeners.submit({ preventDefault() {} });
  const post = calls.find(call => call.url === '/api/v1/deletion-requests' && call.init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { target_id: targetId, reason_code: 'spam', reason: 'Несколько спам-публикаций в школьном чате.' });
  assert.match(f.document.getElementById('ruDeletionRequestStatus').textContent, /Аккаунт не удалён/);
  const renderedReason = f.document.getElementById('ruDeletionOwnRequests').children[0].children[1];
  assert.equal(renderedReason.textContent, '<script>тест</script>');
});

test('school administrator can reject a request and receives no account deletion action', async () => {
  const f = fixture(); const calls = [];
  const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let pending = true;
  await initializeListingModeration({ ...f, fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/v1/me') return { ok: true, json: async () => ({ ok: true, profile: { role: 'school_admin' } }) };
    if (url === '/api/v1/listings/moderation') return { ok: true, json: async () => ({ ok: true, listings: [] }) };
    if (url === '/api/v1/event-registrations/review') return { ok: true, json: async () => ({ ok: true, applications: [] }) };
    if (url === '/api/v1/profile-requests/review' || url === '/api/v1/role-requests/review') return { ok: true, json: async () => ({ ok: true, requests: [] }) };
    if (url === '/api/v1/suspensions') return { ok: true, json: async () => ({ ok: true, suspensions: [] }) };
    if (url === '/api/v1/deletion-requests/review') return { ok: true, json: async () => ({ ok: true, requests: pending ? [{ request_id: requestId, target_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', target_role: 'student', reason_code: 'spam', reason: 'Повторяющиеся спам-публикации.' }] : [] }) };
    if (url === `/api/v1/deletion-requests/${requestId}` && init.method === 'PATCH') { pending = false; return { ok: true, json: async () => ({ ok: true, status: 'rejected' }) }; }
    throw new Error(`unexpected route ${url}`);
  } });
  assert.equal(f.document.getElementById('ruDeletionRequestReview').hidden, false);
  const card = f.document.getElementById('ruDeletionReviewQueue').children[0];
  assert.equal(card.children[2].textContent, 'Причина: Повторяющиеся спам-публикации.');
  const actions = card.children[3].children;
  assert.deepEqual(actions.map(button => button.textContent), ['Отклонить обращение']);
  await actions[0].listeners.click();
  const patch = calls.find(call => call.url === `/api/v1/deletion-requests/${requestId}`);
  assert.deepEqual(JSON.parse(patch.init.body), { decision: 'reject' });
  assert.equal(f.document.getElementById('ruDeletionReviewQueue').children.length, 0);
});
