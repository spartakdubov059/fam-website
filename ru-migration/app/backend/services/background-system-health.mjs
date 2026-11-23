function validQueue(queue, maxAgeMinutes) {
  const statuses = queue?.statuses;
  return statuses && ['queued', 'claimed', 'completed', 'blocked', 'failed'].every(key =>
    Number.isSafeInteger(statuses[key]) && statuses[key] >= 0)
    && Number.isSafeInteger(queue.expired_leases) && queue.expired_leases >= 0
    && Number.isSafeInteger(queue.failed_or_blocked_24h) && queue.failed_or_blocked_24h >= 0
    && Number.isSafeInteger(queue.oldest_queued_age_minutes) && queue.oldest_queued_age_minutes >= 0
    && queue.oldest_queued_age_minutes <= maxAgeMinutes;
}

export function createBackgroundSystemHealthTask({ databaseCheck, schemaCheck, queueHealthCheck } = {}) {
  if ([databaseCheck, schemaCheck, queueHealthCheck].some(check => typeof check !== 'function')) {
    throw new TypeError('background system health checks are required');
  }
  return async function runBackgroundSystemHealthTask() {
    const [databaseReady, schema, queues] = await Promise.all([
      databaseCheck(), schemaCheck(), queueHealthCheck(),
    ]);
    const queueMaxAge = { daily_reports: 26 * 60, site_error_digests: 90, safe_agent_tasks: 120 };
    const queueNames = Object.keys(queueMaxAge);
    const queuesReady = queues?.content_read === false && queues?.queues
      && queueNames.every(name => {
        const queue = queues.queues[name];
        return validQueue(queue, queueMaxAge[name]) && queue.expired_leases === 0 && queue.failed_or_blocked_24h === 0;
      });
    const schemaReady = schema?.ok === true && Number.isSafeInteger(schema.tables_checked)
      && schema.tables_checked > 0 && schema.content_read === false && schema.write_permissions_checked === false;
    if (databaseReady !== true || !schemaReady || !queuesReady) throw new Error('background_system_health_degraded');
    return `Проверка фоновой части FAM: база доступна; схем проверено ${schema.tables_checked}; очереди: ${queueNames.length}/${queueNames.length}. Состояние расписаний и OAuth этим заданием не проверяется; пользовательское содержимое не читалось.`;
  };
}
