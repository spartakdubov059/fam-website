const TASKS = new Set(['queue_health_check', 'daily_report_digest', 'system_health_check', 'site_error_digest']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSafeAgentTaskWorker({ queue, handlers, workerId = 'fam-ru-safe-worker-v1' } = {}) {
  if (!queue || typeof queue.claimSafeTasks !== 'function' || typeof queue.finishSafeTask !== 'function'
      || !handlers || typeof handlers !== 'object') throw new TypeError('safe agent queue and handlers are required');
  return async function processSafeAgentTasks(limit = 3) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new TypeError('invalid safe agent worker limit');
    const tasks = await queue.claimSafeTasks(limit);
    if (!Array.isArray(tasks) || tasks.length > limit) throw new Error('invalid safe agent claim response');
    let completed = 0; let blocked = 0; let failed = 0;
    for (const task of tasks) {
      if (!UUID.test(task?.id || '') || !UUID.test(task?.claim_token || '') || !TASKS.has(task?.task_type)) {
        if (UUID.test(task?.id || '') && UUID.test(task?.claim_token || '')) {
          if (await queue.finishSafeTask({ id: task.id, claimToken: task.claim_token, status: 'blocked',
            summary: 'Задача остановлена: её тип не входит в разрешённый список безопасного обработчика.' })) blocked++;
        }
        continue;
      }
      const handler = handlers[task.task_type];
      if (typeof handler !== 'function') {
        if (await queue.finishSafeTask({ id: task.id, claimToken: task.claim_token, status: 'blocked',
          summary: 'Задача остановлена: обработчик этого типа не настроен.' })) blocked++;
        continue;
      }
      try {
        const summary = await handler();
        if (typeof summary !== 'string' || !summary.trim() || summary.length > 1000) throw new TypeError('invalid safe task summary');
        if (await queue.finishSafeTask({ id: task.id, claimToken: task.claim_token, status: 'completed', summary })) completed++;
      } catch {
        if (await queue.finishSafeTask({ id: task.id, claimToken: task.claim_token, status: 'failed',
          summary: 'Безопасная служебная задача завершилась ошибкой; подробности и данные пользователей не сохранены.' })) failed++;
      }
    }
    return Object.freeze({ claimed: tasks.length, completed, blocked, failed, content_read: false, worker_id: workerId });
  };
}
