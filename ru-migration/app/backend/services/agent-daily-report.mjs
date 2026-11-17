export function createAgentDailyReport({ repository, now = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required');
  return async function refresh() {
    const metrics = await repository.getGlobalAgentDailyMetrics();
    const date = now().toISOString().slice(0, 10);
    const summary = `FAM — сводка за ${date}: активных объявлений ${metrics.listings.active}, новых за сутки ${metrics.listings.new_24h}; непроверенных сигналов безопасности ${metrics.safety.unreviewed}; открытых запросов на удаление ${metrics.account_requests.deletion_pending}; активных временных ограничений ${metrics.account_requests.active_suspensions}; идей: ожидают ${metrics.ideas.pending}, принято ${metrics.ideas.approved}, отклонено ${metrics.ideas.rejected}.`;
    await repository.saveGlobalAgentDailyReport({ date, summary, metrics });
    return { refreshed: true, date };
  };
}
