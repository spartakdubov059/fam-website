import { buildRuSystemHealthReport } from './ru-system-health.mjs';

export function createSystemHealthTaskHandler({ readinessCheck, timerCheck, queueHealthCheck } = {}) {
  if ([readinessCheck, timerCheck, queueHealthCheck].some(check => typeof check !== 'function')) {
    throw new TypeError('system health checks are required');
  }
  return async function runSystemHealthTask() {
    const [readiness, timers, backgroundQueueHealth] = await Promise.all([
      readinessCheck(), timerCheck(), queueHealthCheck(),
    ]);
    const report = buildRuSystemHealthReport({ readiness, timers, backgroundQueueHealth });
    if (!report.ok) throw new Error('system_health_degraded');
    const healthyQueues = [report.queues.dailyReports, report.queues.siteErrorDigests, report.queues.safeAgentTasks]
      .filter(queue => queue.ok).length;
    return `Техническая проверка FAM: готовность backend — да; расписания — ${report.timers.timers.length}/${report.timers.timers.length}; очереди — ${healthyQueues}/3. Проверялись только агрегированные состояния, пользовательское содержимое не читалось.`;
  };
}
