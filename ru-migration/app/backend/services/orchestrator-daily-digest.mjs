const WORKER_ID = 'fam-ru-orchestrator-digest-v1';
const METRIC_KEYS = Object.freeze(['active_listings', 'new_listings_24h', 'pending_ideas', 'queued_tasks',
  'completed_tasks_24h', 'blocked_tasks_24h', 'failed_tasks_24h']);

export function createOrchestratorDailyDigest({ repository, now = () => new Date() } = {}) {
  if (!repository) throw new TypeError('repository is required');
  return async function processDailyDigest() {
    const reportDate = now().toISOString().slice(0, 10);
    const enqueue = await repository.enqueueAgentDailyDigestTask(reportDate);
    const task = await repository.claimAgentDailyDigestTask(WORKER_ID, reportDate);
    if (!task) return { processed: false, created: enqueue.created, date: reportDate };
    if (task.report_date !== reportDate || typeof task.claim_token !== 'string') {
      await repository.retryAgentDailyDigestTask({ reportDate: task.report_date, claimToken: task.claim_token, errorCode: 'digest_failed' });
      throw new Error('invalid agent digest claim');
    }

    try {
      const metrics = await repository.getAgentDailyDigestMetrics();
      if (!metrics || METRIC_KEYS.some(key => !Number.isSafeInteger(metrics[key]) || metrics[key] < 0)) {
        throw new Error('invalid_metrics');
      }
      const summary = `FAM — сводка за ${reportDate}. Активных объявлений: ${metrics.active_listings}; `
        + `новых за сутки: ${metrics.new_listings_24h}; предложений ждут решения: ${metrics.pending_ideas}; `
        + `задач в очереди: ${metrics.queued_tasks}; выполнено за сутки: ${metrics.completed_tasks_24h}; `
        + `заблокировано за сутки: ${metrics.blocked_tasks_24h}; ошибок за сутки: ${metrics.failed_tasks_24h}. `
        + 'Использованы только агрегированные рабочие показатели; личные данные и тексты не читались.';
      const completed = await repository.completeAgentDailyDigestTask({ reportDate, claimToken: task.claim_token, metrics, summary });
      if (!completed) throw new Error('agent digest lease expired');
      return { processed: true, created: enqueue.created, date: reportDate, metrics };
    } catch (error) {
      const errorCode = error?.message === 'invalid_metrics' ? 'invalid_metrics' : 'digest_failed';
      try { await repository.retryAgentDailyDigestTask({ reportDate, claimToken: task.claim_token, errorCode }); } catch { /* the lease expiry permits a later retry */ }
      throw error;
    }
  };
}
