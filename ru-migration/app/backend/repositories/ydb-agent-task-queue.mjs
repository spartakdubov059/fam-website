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
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = 'fam-ru-safe-worker-v1';

function deterministicId(taskType, slot) {
  const bytes = createHash('sha256').update(`fam-ru:${taskType}:${slot}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUtcSlot(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value)) return false;
  const date = new Date(`${value}:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
}

export function createYdbAgentTaskQueue(sql) {
  if (typeof sql !== 'function') throw new TypeError('YDB query client is required');
  return Object.freeze({
    async enqueueSafeTask(taskType, slot) {
      const task = Object.hasOwn(TASKS, taskType) ? TASKS[taskType] : null;
      if (!task || !isUtcSlot(slot)) throw new TypeError('invalid safe agent task');
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
      if (!isUtcSlot(slot)) throw new TypeError('invalid safe coder slot');
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
            AND event_code IN ('js_runtime', 'unhandled_rejection', 'listings_load_failed')
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
            'scheduled_audit', false, ${payloadJson}, NULL, Unwrap(CAST(0 AS Uint32)), Unwrap(CAST(1 AS Uint32)),
            CurrentUtcTimestamp(), NULL, NULL, NULL, NULL, NULL, NULL, CurrentUtcTimestamp(), CurrentUtcTimestamp());`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${taskId}, 'created', ${WORKER_ID},
            'Создана задача ручной проверки по агрегированной категории; автоматические инструменты отключены.', CurrentUtcTimestamp());`;
        return { created: true, id: taskId, task_key: CODER_EVENT_CODES[event.event_code] };
      });
    },

    async claimSafeCoderTask({ workerId, leaseSeconds = 7200 } = {}) {
      if (workerId !== 'fam-agent-qwen-coder-v1' || leaseSeconds !== 7200) throw new TypeError('invalid coder worker claim');
      return sql.begin(async tx => {
        const rows = await tx`SELECT id, payload_json, status, attempt_count, max_attempts,
            CASE WHEN available_at <= CurrentUtcTimestamp() THEN true ELSE false END AS available,
            CASE WHEN lease_expires_at IS NULL OR lease_expires_at <= CurrentUtcTimestamp() THEN true ELSE false END AS lease_expired
          FROM fam_agent_tasks WHERE agent_key = 'technical' AND task_type = 'coder_patch_request'
            AND approval_required = false AND attempt_count < max_attempts
            AND ((status = 'queued' AND available_at <= CurrentUtcTimestamp())
              OR (status IN ('claimed', 'in_progress') AND lease_expires_at <= CurrentUtcTimestamp()))
          ORDER BY available_at ASC, created_at ASC LIMIT 1;`;
        const row = rows?.[0]?.[0];
        if (!row) return null;
        let task;
        try { task = JSON.parse(row.payload_json); } catch { return null; }
        const valid = task && typeof task === 'object' && !Array.isArray(task)
          && Object.keys(task).sort().join(',') === 'event_code,occurrences,page_area,task_key'
          && Object.entries(CODER_EVENT_CODES).some(([eventCode, taskKey]) => eventCode === task.event_code && taskKey === task.task_key)
          && ['auth', 'listings', 'notifications', 'database', 'other'].includes(task.page_area)
          && Number.isInteger(task.occurrences) && task.occurrences >= 0 && task.occurrences <= 1000;
        if (!valid || row.available !== true && row.lease_expired !== true) return null;
        const claimToken = randomUUID();
        await tx`UPDATE fam_agent_tasks SET status = Unwrap(CAST('claimed' AS Utf8)),
            attempt_count = Unwrap(CAST(Unwrap(CAST(attempt_count AS Uint32)) + Unwrap(CAST(1 AS Uint32)) AS Uint32)),
            claimed_by = ${workerId}, claim_token = ${claimToken}, claimed_at = CurrentUtcTimestamp(),
            lease_expires_at = CurrentUtcTimestamp() + Interval('PT2H'), finished_at = CAST(NULL AS Timestamp?),
            updated_at = CurrentUtcTimestamp()
          WHERE id = ${row.id} AND status = ${row.status};`;
        await tx`INSERT INTO fam_agent_task_events (id, task_id, event_type, actor, summary, created_at)
          VALUES (${randomUUID()}, ${row.id}, 'claimed', ${workerId}, 'Агрегированная техническая задача передана ограниченному анализатору.', CurrentUtcTimestamp());`;
        return { id: row.id, ...task, claim_token: claimToken };
      });
    },

    async finishSafeCoderTask({ id, workerId, claimToken, resultCode } = {}) {
      const results = {
        model_completed: ['completed', 'Локальный анализ завершён; любое изменение требует независимой проверки.'],
        model_no_patch: ['completed', 'Подтверждённое исправление не предложено.'],
        model_failed: ['failed', 'Локальный анализатор завершился с ошибкой.'],
        model_blocked: ['blocked', 'Задача остановлена защитными ограничениями.'],
      };
      if (!UUID.test(id || '') || workerId !== 'fam-agent-qwen-coder-v1' || !UUID.test(claimToken || '')
          || !Object.hasOwn(results, resultCode)) throw new TypeError('invalid coder task result');
      const [status, summary] = results[resultCode];
      return sql.begin(async tx => {
        const rows = await tx`SELECT status, claimed_by, claim_token,
            lease_expires_at > CurrentUtcTimestamp() AS lease_valid
          FROM fam_agent_tasks WHERE id = ${id} AND task_type = 'coder_patch_request' LIMIT 1;`;
        const current = rows?.[0]?.[0];
        if (current?.status !== 'claimed' || current.claimed_by !== workerId
            || current.claim_token !== claimToken || current.lease_valid !== true) return false;
        await tx`UPDATE fam_agent_tasks SET status = ${status}, result_summary = ${summary},
            finished_at = CASE WHEN ${status} = 'blocked' THEN CAST(NULL AS Timestamp?) ELSE CurrentUtcTimestamp() END,
            claimed_by = CAST(NULL AS Utf8?),
            claim_token = CAST(NULL AS Utf8?), lease_expires_at = CAST(NULL AS Timestamp?),
            updated_at = CurrentUtcTimestamp() WHERE id = ${id};`;
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
