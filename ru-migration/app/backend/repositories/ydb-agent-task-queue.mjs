import { createHash, randomUUID } from 'node:crypto';

const TASKS = Object.freeze({
  queue_health_check: { agent: 'quality', title: 'Проверка очередей FAM', description: 'Собрать только агрегированные статусы очередей.' },
  daily_report_digest: { agent: 'orchestrator', title: 'Операционная сводка FAM', description: 'Собрать только разрешённые агрегированные показатели.' },
  system_health_check: { agent: 'technical', title: 'Проверка состояния FAM', description: 'Проверить только служебное состояние backend и расписаний.' },
  site_error_digest: { agent: 'technical', title: 'Сводка технических ошибок FAM', description: 'Собрать только разрешённые агрегаты клиентских ошибок.' },
});
const CODER_EVENT_CODES = Object.freeze({
  js_runtime: 'audit_frontend_runtime',
  unhandled_rejection: 'audit_frontend_runtime',
  listings_load_failed: 'audit_client_resilience',
  notifications_load_failed: 'audit_client_resilience',
  database_request_failed: 'audit_client_resilience',
  auth_backend_failed: 'audit_client_resilience',
  ci_workflow_failure: 'audit_agent_infrastructure',
  worker_queue_failure: 'audit_agent_infrastructure',
  worker_expired_lease: 'audit_agent_infrastructure',
  qwen_repeated_failure: 'audit_agent_infrastructure',
  qwen_stuck_run: 'audit_agent_infrastructure',
  synthetic_ci_workflow_failure: 'audit_agent_infrastructure',
});
const INSPECTOR_SIGNAL_CODES = new Set([
  'ci_workflow_failure', 'worker_queue_failure', 'worker_expired_lease',
  'qwen_repeated_failure', 'qwen_stuck_run', 'synthetic_ci_workflow_failure',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = 'fam-ru-safe-worker-v1';
const CODER_WORKER_ID = 'fam-agent-qwen-coder-v1';
const CODER_SUMMARY = Object.freeze({
  claimed: 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.',
  model_generated: 'Модель подготовила предложение; независимая QA ещё не подтверждена.',
  qa_passed: 'Независимая QA прошла; PR ещё не создан.',
});
const CODER_STAGES = Object.freeze({
  model_generated: { expected: CODER_SUMMARY.claimed, summary: CODER_SUMMARY.model_generated, renew: true },
  qa_passed: { expected: CODER_SUMMARY.model_generated, summary: CODER_SUMMARY.qa_passed, renew: true },
  pr_created: { expected: CODER_SUMMARY.qa_passed, summary: 'PR создан после независимой QA; ожидает решения владельца.', release: true },
  qa_failed: { expected: CODER_SUMMARY.qa_passed, summary: 'Независимая QA не прошла; изменение не считается выполненным.', status: 'blocked' },
  model_no_patch: { expected: CODER_SUMMARY.claimed, summary: 'Локальная модель не предложила подтверждённое исправление.', status: 'completed' },
  model_failed: { expected: CODER_SUMMARY.claimed, summary: 'Локальный анализатор завершился с ошибкой.', status: 'failed' },
  model_blocked: { expected: CODER_SUMMARY.claimed, summary: 'Задание остановлено защитными ограничениями.', status: 'blocked' },
});

function deterministicId(taskType, slot) {
  const bytes = createHash('sha256').update(`fam-ru:${taskType}:${slot}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseUtcMinuteSlot(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const date = new Date(`${value}:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value ? date : null;
}

function isUtcTaskSlot(taskType, value) {
  const date = parseUtcMinuteSlot(value);
  if (!date) return false;
  const hour = date.getUTCHours(); const minute = date.getUTCMinutes();
  if (taskType === 'system_health_check') return hour === 3 && minute === 40;
  if (taskType === 'daily_report_digest') return hour === 4 && minute === 0;
  if (taskType === 'site_error_digest') return minute === 30;
  return taskType === 'queue_health_check' && [0, 15, 30, 45].includes(minute);
}

export function createYdbAgentTaskQueue(sql) {
  if (typeof sql !== 'function') throw new TypeError('YDB query client is required');
  return Object.freeze({
    async enqueueInspectorSignal({ signalCode, eventId, occurrences } = {}) {
      if (!INSPECTOR_SIGNAL_CODES.has(signalCode)
          || typeof eventId !== 'string'
          || !/^[a-z0-9:_-]{3,100}$/.test(eventId)
          || !Number.isSafeInteger(occurrences)
          || occurrences < 1
          || occurrences > 1000) {
        throw new TypeError('invalid inspector signal');
      }
      return sql.begin({ idempotent: true }, async tx => {
        const existing = await tx`SELECT outcome FROM fam_agent_inspector_signals WHERE event_id = ${eventId} LIMIT 1;`;
        if (existing?.[0]?.[0]) return { ok: true, task_created: false, reason: 'duplicate_event' };

        const cooldown = await tx`SELECT event_id FROM fam_agent_inspector_signals
          WHERE signal_code = ${signalCode} AND outcome = 'queued'
            AND created_at > CurrentUtcTimestamp() - Interval('P7D') LIMIT 1;`;
        if (cooldown?.[0]?.[0]) {
          await tx`INSERT INTO fam_agent_inspector_signals
            (event_id, signal_code, signature, outcome, task_id, created_at)
            VALUES (${eventId}, ${signalCode}, ${signalCode}, 'deduped', CAST(NULL AS Utf8?), CurrentUtcTimestamp());`;
          return { ok: true, task_created: false, reason: 'signal_cooldown' };
        }

        const active = await tx`SELECT id FROM fam_agent_tasks
          WHERE agent_key = 'technical' AND task_type = 'coder_patch_request'
            AND status IN ('queued', 'claimed', 'in_progress') LIMIT 1;`;
        if (active?.[0]?.[0]) {
          await tx`INSERT INTO fam_agent_inspector_signals
            (event_id, signal_code, signature, outcome, task_id, created_at)
            VALUES (${eventId}, ${signalCode}, ${signalCode}, 'active_task', CAST(NULL AS Utf8?), CurrentUtcTimestamp());`;
          return { ok: true, task_created: false, reason: 'coder_task_already_active' };
        }

        const taskId = randomUUID();
        const priority = ['worker_queue_failure', 'worker_expired_lease'].includes(signalCode) ? 'high' : 'normal';
        const payloadJson = JSON.stringify({
          task_key: 'audit_agent_infrastructure',
          event_code: signalCode,
          page_area: 'agent_infrastructure',
          occurrences,
        });
        await tx`INSERT INTO fam_agent_tasks
          (id, agent_key, task_type, title, description, priority, status, source, approval_required,
            payload_json, result_summary, attempt_count, max_attempts, available_at, claim_token,
            claimed_by, claimed_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
          VALUES (${taskId}, 'technical', 'coder_patch_request',
            'Проверка подтверждённого сигнала инфраструктуры агентов',
            'Проверить узкую область управляющей инфраструктуры по коду сигнала. Не читать журналы, пользовательские данные или секреты.',
            ${priority}, 'queued', 'scheduled_audit', false, ${payloadJson}, NULL,
            Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(2 AS Uint32)), CurrentUtcTimestamp(), NULL,
            NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_agent_inspector_signals
          (event_id, signal_code, signature, outcome, task_id, created_at)
          VALUES (${eventId}, ${signalCode}, ${signalCode}, 'queued', ${taskId}, CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_agent_task_events
          (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${taskId}, 'created', 'fam-agent-inspector',
            'INSPECTOR поставил ограниченную техническую проверку в очередь.', CurrentUtcTimestamp());`;
        return { ok: true, task_created: true, task_id: taskId, reason: 'queued' };
      });
    },

    async enqueueSafeTask(taskType, slot) {
      const task = Object.hasOwn(TASKS, taskType) ? TASKS[taskType] : null;
      if (!task || !isUtcTaskSlot(taskType, slot)) throw new TypeError('invalid safe agent task');
      const id = deterministicId(taskType, slot);
      return sql.begin(async tx => {
        const existing = await tx`SELECT status FROM fam_agent_tasks WHERE id = ${id} LIMIT 1;`;
        if (existing?.[0]?.[0]) return { created: false, status: existing[0][0].status, id };
        await tx`INSERT INTO fam_agent_tasks
          (id, agent_key, task_type, title, description, priority, status, source, approval_required,
            payload_json, result_summary, attempt_count, max_attempts, available_at, claim_token,
            claimed_by, claimed_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
          VALUES (${id}, ${task.agent}, ${taskType}, ${task.title}, ${task.description}, 'normal', 'queued',
            'scheduled_audit', false, '{}', NULL, Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(3 AS Uint32)),
            CurrentUtcTimestamp(), NULL, NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${id}, 'created', ${WORKER_ID}, 'Создана безопасная задача с агрегированными данными.', CurrentUtcTimestamp());`;
        return { created: true, status: 'queued', id };
      });
    },

    async enqueueSafeCoderTask(slot) {
      const date = parseUtcMinuteSlot(slot);
      if (!date || ![0, 15, 30, 45].includes(date.getUTCMinutes())) throw new TypeError('invalid safe coder slot');
      return sql.begin(async tx => {
        const taskId = deterministicId('coder_patch_request', slot);
        const prior = await tx`SELECT status FROM fam_agent_tasks WHERE id = ${taskId} LIMIT 1;`;
        if (prior?.[0]?.[0]) return { created: false, reason: 'already_processed', id: taskId };
        const active = await tx`SELECT id FROM fam_agent_tasks WHERE agent_key = 'technical'
          AND task_type = 'coder_patch_request' AND status IN ('queued', 'claimed', 'in_progress') LIMIT 1;`;
        if (active?.[0]?.[0]) return { created: false, id: active[0][0].id };
        const rows = await tx`SELECT event_code, page_area, SUM(event_count) AS occurrences
          FROM fam_site_error_counts
          WHERE hour_bucket >= CurrentUtcTimestamp() - Interval('PT24H')
            AND event_code IN ('js_runtime', 'unhandled_rejection', 'listings_load_failed',
              'notifications_load_failed', 'database_request_failed', 'auth_backend_failed')
          GROUP BY event_code, page_area HAVING SUM(event_count) >= 3
          ORDER BY occurrences DESC, event_code, page_area LIMIT 1;`;
        const event = rows?.[0]?.[0];
        if (!event || !Object.hasOwn(CODER_EVENT_CODES, event.event_code)) return { created: false, reason: 'no_threshold_event' };
        const rawOccurrences = Number(event.occurrences);
        if (!Number.isSafeInteger(rawOccurrences) || rawOccurrences < 3) throw new Error('invalid aggregate event count');
        const occurrences = Math.min(rawOccurrences, 1000);
        const payloadJson = JSON.stringify({ task_key: CODER_EVENT_CODES[event.event_code],
          event_code: event.event_code, page_area: event.page_area, occurrences });
        await tx`INSERT INTO fam_agent_tasks
          (id, agent_key, task_type, title, description, priority, status, source, approval_required,
            payload_json, result_summary, attempt_count, max_attempts, available_at, claim_token,
            claimed_by, claimed_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
          VALUES (${taskId}, 'technical', 'coder_patch_request', 'Безопасный анализ технического события FAM',
            'Автоматический анализ отключён. Требуется ручная проверка агрегированной категории.', 'normal', 'queued',
            'scheduled_audit', false, ${payloadJson}, NULL, Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(2 AS Uint32)),
            CurrentUtcTimestamp(), NULL, NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${taskId}, 'created', ${WORKER_ID},
            'Создана задача ручной проверки по агрегированной категории; автоматические инструменты отключены.', CurrentUtcTimestamp());`;
        return { created: true, id: taskId, task_key: CODER_EVENT_CODES[event.event_code] };
      });
    },

    async claimSafeCoderTask({ workerId, leaseSeconds = 7200 } = {}) {
      if (workerId !== 'fam-agent-qwen-coder-v1' || leaseSeconds !== 7200) throw new TypeError('invalid coder worker claim');
      return sql.begin({ idempotent: true }, async tx => {
        const staleQueued = await tx`SELECT id FROM fam_agent_tasks
          WHERE agent_key = 'technical' AND task_type = 'coder_patch_request'
            AND approval_required = false AND source IN ('system', 'scheduled_audit')
            AND status = 'queued' AND created_at < CurrentUtcTimestamp() - Interval('P7D')
          ORDER BY created_at ASC LIMIT 50;`;
        for (const task of staleQueued?.[0] ?? []) {
          const summary = 'Задача закрыта: техническое задание устарело в очереди.';
          const closed = await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('failed' AS Utf8)),
              claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
              claimed_at = CAST(NULL AS Timestamp?), lease_expires_at = CAST(NULL AS Timestamp?),
              finished_at = CurrentUtcTimestamp(), result_summary = ${summary},
              updated_at = CurrentUtcTimestamp()
            WHERE id = ${task.id} AND agent_key = 'technical' AND task_type = 'coder_patch_request'
              AND approval_required = false AND source IN ('system', 'scheduled_audit')
              AND status = 'queued' AND created_at < CurrentUtcTimestamp() - Interval('P7D')
            RETURNING id;`;
          if (closed?.[0]?.[0]) {
            await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
              VALUES (${randomUUID()}, ${task.id}, 'failed', ${workerId},
                'Задача закрыта без запуска модели: возраст очереди превысил семь дней.', CurrentUtcTimestamp());`;
          }
        }
        const activeTasks = await tx`SELECT id FROM fam_agent_tasks
          WHERE agent_key = 'technical' AND task_type = 'coder_patch_request'
            AND status IN ('queued', 'claimed', 'in_progress') LIMIT 1;`;
        const retryableFailures = await tx`SELECT id FROM fam_agent_tasks
          WHERE agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') AND status = 'failed'
            AND result_summary = 'Локальный анализатор завершился с ошибкой.'
            AND attempt_count < max_attempts AND created_at >= CurrentUtcTimestamp() - Interval('P7D')
          ORDER BY updated_at ASC LIMIT 1;`;
        for (const task of activeTasks?.[0]?.length ? [] : retryableFailures?.[0] ?? []) {
          const summary = 'Повторная попытка поставлена в очередь после ограниченной ошибки запуска.';
          await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('queued' AS Utf8)),
              result_summary = ${summary}, claimed_by = CAST(NULL AS Utf8?),
              claim_token = CAST(NULL AS Utf8?), claimed_at = CAST(NULL AS Timestamp?),
              lease_expires_at = CAST(NULL AS Timestamp?), started_at = CAST(NULL AS Timestamp?),
              finished_at = CAST(NULL AS Timestamp?), available_at = CurrentUtcTimestamp(),
              updated_at = CurrentUtcTimestamp()
            WHERE id = ${task.id} AND agent_key = 'technical' AND task_type = 'coder_patch_request'
              AND approval_required = false AND source IN ('system', 'scheduled_audit')
              AND status = 'failed' AND result_summary = 'Локальный анализатор завершился с ошибкой.'
              AND attempt_count < max_attempts;`;
          await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
            VALUES (${randomUUID()}, ${task.id}, 'retry_scheduled', ${workerId},
              'Временный сбой запуска будет повторён в пределах разрешённого лимита.', CurrentUtcTimestamp());`;
        }
        const exhausted = await tx`SELECT id, claim_token FROM fam_agent_tasks
          WHERE agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') AND claimed_by = ${workerId}
            AND status IN ('claimed', 'in_progress') AND lease_expires_at <= CurrentUtcTimestamp()
            AND attempt_count >= max_attempts LIMIT 1;`;
        for (const task of exhausted?.[0] ?? []) {
          const summary = 'Локальный анализатор исчерпал число попыток после истечения аренды.';
          await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('failed' AS Utf8)),
              result_summary = ${summary}, claimed_by = CAST(NULL AS Utf8?),
              claim_token = CAST(NULL AS Utf8?), claimed_at = CAST(NULL AS Timestamp?),
              lease_expires_at = CAST(NULL AS Timestamp?), finished_at = CurrentUtcTimestamp(),
              updated_at = CurrentUtcTimestamp()
            WHERE id = ${task.id} AND claim_token = ${task.claim_token}
              AND claimed_by = ${workerId} AND status IN ('claimed', 'in_progress')
              AND lease_expires_at <= CurrentUtcTimestamp() AND attempt_count >= max_attempts;`;
          await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
            VALUES (${randomUUID()}, ${task.id}, 'failed', ${workerId},
              'Задача закрыта после истечения аренды последней разрешённой попытки.', CurrentUtcTimestamp());`;
        }
        const recovered = await tx`SELECT id, claim_token FROM fam_agent_tasks
          WHERE agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') AND claimed_by = ${workerId}
            AND status IN ('claimed', 'in_progress') AND lease_expires_at <= CurrentUtcTimestamp()
            AND attempt_count < max_attempts;`;
        for (const task of recovered?.[0] ?? []) {
          const summary = 'Повторная попытка поставлена в очередь после истечения аренды.';
          await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('queued' AS Utf8)),
              result_summary = ${summary}, claimed_by = CAST(NULL AS Utf8?),
              claim_token = CAST(NULL AS Utf8?), claimed_at = CAST(NULL AS Timestamp?),
              lease_expires_at = CAST(NULL AS Timestamp?), started_at = CAST(NULL AS Timestamp?),
              finished_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp()
            WHERE id = ${task.id} AND claim_token = ${task.claim_token}
              AND claimed_by = ${workerId} AND status IN ('claimed', 'in_progress')
              AND lease_expires_at <= CurrentUtcTimestamp() AND attempt_count < max_attempts;`;
          await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
            VALUES (${randomUUID()}, ${task.id}, 'retry_scheduled', ${workerId},
              'Истёк lease; задача возвращена в очередь для ограниченного повтора.', CurrentUtcTimestamp());`;
        }
        const rows = await tx`SELECT id, payload_json, status, attempt_count, max_attempts,
            CASE WHEN available_at <= CurrentUtcTimestamp() THEN true ELSE false END AS available,
            CASE WHEN lease_expires_at IS NULL OR lease_expires_at <= CurrentUtcTimestamp() THEN true ELSE false END AS lease_expired
          FROM fam_agent_tasks WHERE agent_key = 'technical' AND task_type = 'coder_patch_request'
            AND approval_required = false AND attempt_count < max_attempts
            AND status = 'queued' AND available_at <= CurrentUtcTimestamp()
            AND created_at >= CurrentUtcTimestamp() - Interval('P7D')
          ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            created_at ASC LIMIT 1;`;
        const row = rows?.[0]?.[0];
        if (!row) return null;
        let task;
        try { task = JSON.parse(row.payload_json); } catch { return null; }
        const valid = task && typeof task === 'object' && !Array.isArray(task)
          && Object.keys(task).sort().join(',') === 'event_code,occurrences,page_area,task_key'
          && Object.entries(CODER_EVENT_CODES).some(([eventCode, taskKey]) => eventCode === task.event_code && taskKey === task.task_key)
          && ['auth', 'listings', 'notifications', 'database', 'other', 'agent_infrastructure'].includes(task.page_area)
          && Number.isInteger(task.occurrences) && task.occurrences >= 0 && task.occurrences <= 1000;
        if (!valid || row.available !== true && row.lease_expired !== true) return null;
        const claimToken = randomUUID();
        const claimed = await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('claimed' AS Utf8)),
            result_summary = 'Ограниченное техническое задание принято локальным анализатором.',
            attempt_count = Unwrap(CAST(Unwrap(CAST(attempt_count AS Uint32)) + Unwrap(CAST(1 AS Uint32)) AS Uint32)),
            claimed_by = ${workerId}, claim_token = ${claimToken}, claimed_at = CurrentUtcTimestamp(),
            lease_expires_at = CurrentUtcTimestamp() + Interval('PT2H'), finished_at = CAST(NULL AS Timestamp?),
            updated_at = CurrentUtcTimestamp()
          WHERE id = ${row.id} AND status = ${row.status}
            AND attempt_count = ${row.attempt_count} AND attempt_count < max_attempts
          RETURNING id;`;
        if (!claimed?.[0]?.[0]) return null;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${row.id}, 'claimed', ${workerId}, 'Агрегированная техническая задача передана ограниченному анализатору.', CurrentUtcTimestamp());`;
        return { id: row.id, ...task, claim_token: claimToken };
      });
    },

    async startSafeCoderTask({ id, workerId, claimToken, leaseSeconds = 1800 } = {}) {
      if (!UUID.test(id || '') || workerId !== CODER_WORKER_ID || !UUID.test(claimToken || '')
          || leaseSeconds !== 1800) {
        throw new TypeError('invalid coder task start');
      }
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claimed_by, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_tasks WHERE id = ${id} AND agent_key = 'technical'
            AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') LIMIT 1;`;
        const task = rows?.[0]?.[0];
        if (task?.status !== 'claimed' || task.claimed_by !== workerId || task.claim_token !== claimToken
            || task.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_tasks SET status = 'in_progress',
            started_at = CASE WHEN started_at IS NULL THEN CurrentUtcTimestamp() ELSE started_at END,
            lease_expires_at = CurrentUtcTimestamp() + Interval('PT30M'),
            result_summary = ${CODER_SUMMARY.claimed}, updated_at = CurrentUtcTimestamp()
          WHERE id = ${id} AND claimed_by = ${workerId} AND claim_token = ${claimToken}
            AND agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') AND status = 'claimed'
            AND lease_expires_at > CurrentUtcTimestamp();`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${id}, 'started', ${workerId},
            'Локальный анализ начат с ограниченной арендой.', CurrentUtcTimestamp());`;
        return true;
      });
    },

    async heartbeatSafeCoderTask({ id, workerId, claimToken, leaseSeconds = 1800 } = {}) {
      if (!UUID.test(id || '') || workerId !== CODER_WORKER_ID || !UUID.test(claimToken || '')
          || leaseSeconds !== 1800) {
        throw new TypeError('invalid coder task heartbeat');
      }
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, result_summary, claimed_by, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_tasks WHERE id = ${id} AND agent_key = 'technical'
            AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') LIMIT 1;`;
        const task = rows?.[0]?.[0];
        if (task?.status !== 'in_progress' || !Object.values(CODER_SUMMARY).includes(task.result_summary)
            || task.claimed_by !== workerId || task.claim_token !== claimToken || task.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_tasks SET lease_expires_at = CurrentUtcTimestamp() + Interval('PT30M'),
            updated_at = CurrentUtcTimestamp()
          WHERE id = ${id} AND claimed_by = ${workerId} AND claim_token = ${claimToken}
            AND agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') AND status = 'in_progress'
            AND lease_expires_at > CurrentUtcTimestamp();`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${id}, 'progress', ${workerId},
            'Активный анализ подтвердил продление ограниченной аренды.', CurrentUtcTimestamp());`;
        return true;
      });
    },

    async advanceSafeCoderTask({ id, workerId, claimToken, stage, prNumber } = {}) {
      const transition = Object.hasOwn(CODER_STAGES, stage) ? CODER_STAGES[stage] : null;
      if (!UUID.test(id || '') || workerId !== CODER_WORKER_ID || !UUID.test(claimToken || '') || !transition
          || (stage === 'pr_created' && (!Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 99_999_999))
          || (stage !== 'pr_created' && prNumber !== undefined)) throw new TypeError('invalid coder task stage');
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, result_summary, claimed_by, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_tasks WHERE id = ${id} AND agent_key = 'technical'
            AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') LIMIT 1;`;
        const task = rows?.[0]?.[0];
        if (task?.status !== 'in_progress' || task.result_summary !== transition.expected
            || task.claimed_by !== workerId || task.claim_token !== claimToken || task.lease_valid !== true) return false;
        const status = transition.status || 'in_progress';
        const release = Boolean(transition.status || transition.release);
        const finished = status === 'completed';
        const eventType = status === 'in_progress' ? 'progress' : status;
        const summary = stage === 'pr_created' ? `${transition.summary} №${prNumber}.` : transition.summary;
        if (release) {
          if (finished) {
            await tx`UPDATE fam_agent_tasks SET status = ${status}, result_summary = ${summary},
                finished_at = CurrentUtcTimestamp(), lease_expires_at = CAST(NULL AS Timestamp?),
                claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
                claimed_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp()
              WHERE id = ${id} AND claimed_by = ${workerId} AND claim_token = ${claimToken}
                AND agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
                AND source IN ('system', 'scheduled_audit')
                AND status = 'in_progress' AND result_summary = ${transition.expected}
                AND lease_expires_at > CurrentUtcTimestamp();`;
          } else {
            await tx`UPDATE fam_agent_tasks SET status = ${status}, result_summary = ${summary},
                finished_at = CAST(NULL AS Timestamp?), lease_expires_at = CAST(NULL AS Timestamp?),
                claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
                claimed_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp()
              WHERE id = ${id} AND claimed_by = ${workerId} AND claim_token = ${claimToken}
                AND agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
                AND source IN ('system', 'scheduled_audit')
                AND status = 'in_progress' AND result_summary = ${transition.expected}
                AND lease_expires_at > CurrentUtcTimestamp();`;
          }
        } else {
          await tx`UPDATE fam_agent_tasks SET status = ${status}, result_summary = ${summary},
              finished_at = CAST(NULL AS Timestamp?), lease_expires_at = CurrentUtcTimestamp() + Interval('PT2H'),
              updated_at = CurrentUtcTimestamp()
            WHERE id = ${id} AND claimed_by = ${workerId} AND claim_token = ${claimToken}
              AND agent_key = 'technical' AND task_type = 'coder_patch_request' AND approval_required = false
              AND source IN ('system', 'scheduled_audit')
              AND status = 'in_progress' AND result_summary = ${transition.expected}
              AND lease_expires_at > CurrentUtcTimestamp();`;
        }
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${id}, ${eventType}, ${workerId}, ${summary}, CurrentUtcTimestamp());`;
        return true;
      });
    },

    async finishSafeCoderTask({ id, workerId, claimToken, resultCode } = {}) {
      const results = {
        model_no_patch: ['completed', 'Локальная модель не предложила подтверждённое исправление.'],
        model_failed: ['failed', 'Локальный анализатор завершился с ошибкой.'],
        model_blocked: ['blocked', 'Задание остановлено защитными ограничениями.'],
      };
      if (!UUID.test(id || '') || workerId !== 'fam-agent-qwen-coder-v1' || !UUID.test(claimToken || '')
          || !Object.hasOwn(results, resultCode)) throw new TypeError('invalid coder task result');
      const [status, summary] = results[resultCode];
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claimed_by, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_tasks WHERE id = ${id} AND agent_key = 'technical'
            AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (!['claimed', 'in_progress'].includes(current?.status) || current.claimed_by !== workerId
            || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_tasks SET status = ${status}, result_summary = ${summary},
            finished_at = CASE WHEN ${status} = 'blocked' THEN CAST(NULL AS Timestamp?) ELSE CurrentUtcTimestamp() END,
            claimed_by = CAST(NULL AS Utf8?),
            claim_token = CAST(NULL AS Utf8?), lease_expires_at = CAST(NULL AS Timestamp?),
            updated_at = CurrentUtcTimestamp() WHERE id = ${id} AND agent_key = 'technical'
            AND task_type = 'coder_patch_request' AND approval_required = false
            AND source IN ('system', 'scheduled_audit') AND claimed_by = ${workerId}
            AND claim_token = ${claimToken} AND status IN ('claimed', 'in_progress')
            AND lease_expires_at > CurrentUtcTimestamp();`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${id}, ${status}, ${workerId}, ${summary}, CurrentUtcTimestamp());`;
        return true;
      });
    },

    async claimSafeTasks(limit = 3) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new TypeError('invalid safe agent task limit');
      return sql.begin(async tx => {
        const rows = await tx`SELECT id, agent_key, task_type, approval_required, status, attempt_count, max_attempts,
            CASE WHEN available_at <= CurrentUtcTimestamp() THEN true ELSE false END AS available,
            CASE WHEN lease_expires_at IS NULL OR lease_expires_at <= CurrentUtcTimestamp() THEN true ELSE false END AS lease_expired
          FROM fam_agent_tasks
          WHERE approval_required = false AND task_type IN ('queue_health_check', 'daily_report_digest', 'system_health_check', 'site_error_digest')
            AND attempt_count < max_attempts
            AND ((status IN ('queued', 'failed') AND available_at <= CurrentUtcTimestamp())
              OR (status IN ('claimed', 'in_progress') AND lease_expires_at <= CurrentUtcTimestamp()))
          ORDER BY available_at ASC, created_at ASC LIMIT ${limit};`;
        const claimed = [];
        for (const row of rows?.[0] ?? []) {
          if (row.approval_required !== false || !TASKS[row.task_type] || row.agent_key !== TASKS[row.task_type].agent) continue;
          const token = randomUUID();
          await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('claimed' AS Utf8)),
              attempt_count = Unwrap(CAST(Unwrap(CAST(attempt_count AS Uint32)) + Unwrap(CAST(1 AS Uint32)) AS Uint32)),
              claimed_by = ${WORKER_ID}, claim_token = ${token}, claimed_at = CurrentUtcTimestamp(),
              lease_expires_at = CurrentUtcTimestamp() + Interval('PT2M'), finished_at = CAST(NULL AS Timestamp?),
              updated_at = CurrentUtcTimestamp()
            WHERE id = ${row.id};`;
          await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
            VALUES (${randomUUID()}, ${row.id}, 'claimed', ${WORKER_ID}, 'Задача передана ограниченному RU worker.', CurrentUtcTimestamp());`;
          claimed.push({ id: row.id, task_type: row.task_type, agent_key: row.agent_key, claim_token: token });
        }
        return claimed;
      });
    },

    async finishSafeTask({ id, claimToken, status, summary }) {
      if (!UUID.test(id || '') || !UUID.test(claimToken || '') || !['completed', 'blocked', 'failed'].includes(status)
          || typeof summary !== 'string' || summary.trim().length < 1 || summary.length > 1000) {
        throw new TypeError('invalid safe agent task result');
      }
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claimed_by, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_tasks WHERE id = ${id} LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.status !== 'claimed' || current.claimed_by !== WORKER_ID
            || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_tasks SET status = ${status}, result_summary = ${summary},
            finished_at = CurrentUtcTimestamp(), claimed_by = CAST(NULL AS Utf8?), claim_token = CAST(NULL AS Utf8?),
            lease_expires_at = CAST(NULL AS Timestamp?), updated_at = CurrentUtcTimestamp() WHERE id = ${id};`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${id}, ${status}, ${WORKER_ID}, ${summary}, CurrentUtcTimestamp());`;
        return true;
      });
    },

    async getAgentTaskQueueHealth() {
      const [statuses, failed, expired, oldest] = await Promise.all([
        sql`SELECT status, COUNT(*) AS count FROM fam_agent_tasks GROUP BY status;`,
        sql`SELECT COUNT(*) AS count FROM fam_agent_tasks WHERE status = 'failed'
          AND updated_at >= CurrentUtcTimestamp() - Interval('PT24H');`,
        sql`SELECT COUNT(*) AS count FROM fam_agent_tasks WHERE status IN ('claimed', 'in_progress')
          AND lease_expires_at <= CurrentUtcTimestamp();`,
        sql`SELECT MIN(created_at) AS oldest_queued_at FROM fam_agent_tasks WHERE status = 'queued';`,
      ]);
      const counts = { queued: 0, claimed: 0, in_progress: 0 };
      for (const row of statuses?.[0] ?? []) {
        if (!Object.hasOwn(counts, row.status) && !['failed', 'blocked', 'completed', 'cancelled'].includes(row.status)) {
          throw new TypeError('invalid agent task status');
        }
        if (Object.hasOwn(counts, row.status)) {
          const value = Number(row.count);
          if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) throw new TypeError('invalid agent task count');
          counts[row.status] = value;
        }
      }
      const failedLast24 = Number(failed?.[0]?.[0]?.count ?? 0);
      const expiredLeases = Number(expired?.[0]?.[0]?.count ?? 0);
      if (![failedLast24, expiredLeases].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)) {
        throw new TypeError('invalid agent task health count');
      }
      const oldestValue = oldest?.[0]?.[0]?.oldest_queued_at;
      const oldestMs = oldestValue instanceof Date ? oldestValue.getTime()
        : typeof oldestValue === 'string' ? Date.parse(oldestValue) : NaN;
      const health = {
        queued: counts.queued,
        claimed: counts.claimed,
        in_progress: counts.in_progress,
        failed_last_24h: failedLast24,
        expired_leases: expiredLeases,
        oldest_queued_minutes: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((Date.now() - oldestMs) / 60_000)) : 0,
      };
      if (Object.values(health).some(value => !Number.isSafeInteger(value) || value < 0 || value > 10_000_000)) {
        throw new TypeError('invalid agent task health age');
      }
      return health;
    },

    async getAgentTaskMetrics() {
      const agents = new Set(['orchestrator', 'technical', 'database', 'moderation', 'safety', 'quality', 'growth']);
      const statuses = new Set(['queued', 'claimed', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']);
      const rows = await sql`SELECT agent_key, status, COUNT(*) AS count FROM fam_agent_tasks
        GROUP BY agent_key, status ORDER BY agent_key, status LIMIT 50;`;
      const metrics = [];
      for (const row of rows?.[0] ?? []) {
        const count = Number(row.count);
        if (!agents.has(row.agent_key) || !statuses.has(row.status)
            || !Number.isSafeInteger(count) || count < 0 || count > 10_000_000) {
          throw new TypeError('invalid agent task metrics');
        }
        metrics.push({ agent_key: row.agent_key, status: row.status, count });
      }
      if (metrics.length > 49) throw new TypeError('invalid agent task metrics');
      return metrics;
    },

    async getSafeTaskQueueHealth() {
      const [statuses, expired, recentFailures, oldest] = await Promise.all([
        sql`SELECT status, COUNT(*) AS count FROM fam_agent_tasks
          WHERE task_type IN ('queue_health_check', 'daily_report_digest', 'system_health_check', 'site_error_digest') GROUP BY status;`,
        sql`SELECT COUNT(*) AS count FROM fam_agent_tasks WHERE task_type IN ('queue_health_check', 'daily_report_digest', 'system_health_check', 'site_error_digest')
          AND status = 'claimed' AND lease_expires_at <= CurrentUtcTimestamp();`,
        sql`SELECT COUNT(*) AS count FROM fam_agent_tasks WHERE task_type IN ('queue_health_check', 'daily_report_digest', 'system_health_check', 'site_error_digest')
          AND status IN ('failed', 'blocked') AND updated_at >= CurrentUtcTimestamp() - Interval('PT24H');`,
        sql`SELECT MIN(available_at) AS oldest_queued_at FROM fam_agent_tasks WHERE task_type IN ('queue_health_check', 'daily_report_digest', 'system_health_check', 'site_error_digest') AND status = 'queued';`,
      ]);
      const counts = { queued: 0, claimed: 0, in_progress: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0 };
      for (const row of statuses?.[0] ?? []) {
        if (!Object.hasOwn(counts, row.status)) throw new TypeError('invalid agent task status');
        const value = Number(row.count);
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid agent task count');
        counts[row.status] = value;
      }
      const oldestValue = oldest?.[0]?.[0]?.oldest_queued_at;
      const oldestMs = oldestValue instanceof Date ? oldestValue.getTime() : typeof oldestValue === 'string' ? Date.parse(oldestValue) : NaN;
      const expiredLeases = Number(expired?.[0]?.[0]?.count ?? 0);
      const failedOrBlocked = Number(recentFailures?.[0]?.[0]?.count ?? 0);
      if (!Number.isSafeInteger(expiredLeases) || expiredLeases < 0
          || !Number.isSafeInteger(failedOrBlocked) || failedOrBlocked < 0) throw new TypeError('invalid agent task health count');
      return { statuses: counts, expired_leases: expiredLeases,
        failed_or_blocked_24h: failedOrBlocked,
        oldest_queued_age_minutes: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((Date.now() - oldestMs) / 60_000)) : 0,
        content_read: false };
    },
  });
}
