const WORKER_ID = 'fam-ru-site-error-digest-v1';
const EVENT_CODES = new Set(['js_runtime', 'unhandled_rejection',
  'listings_load_failed', 'notifications_load_failed', 'database_request_failed', 'auth_backend_failed']);
const PAGE_AREAS = new Set(['auth', 'listings', 'notifications', 'database', 'other']);

export function getSiteErrorDigestSlot(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid site error digest time');
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15, 0, 0);
  return date.toISOString().slice(0, 16);
}

function validateMetrics(metrics) {
  if (!metrics || !Number.isSafeInteger(metrics.total_events_24h) || metrics.total_events_24h < 0
      || !Number.isSafeInteger(metrics.events_last_hour) || metrics.events_last_hour < 0
      || !Array.isArray(metrics.events) || metrics.events.length > 6
      || metrics.events.some(row => !EVENT_CODES.has(row.event_code) || !PAGE_AREAS.has(row.page_area)
        || !Number.isSafeInteger(row.occurrences) || row.occurrences < 0)) throw new Error('invalid_metrics');
  return metrics;
}

export function createSiteErrorDigest({ repository, now = () => new Date() } = {}) {
  if (!repository) throw new TypeError('repository is required');
  return async function processSiteErrorDigest() {
    const currentSlot = getSiteErrorDigestSlot(now());
    const enqueue = await repository.enqueueSiteErrorDigestTask(currentSlot);
    const processedSlots = []; const completedMetrics = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const task = await repository.claimSiteErrorDigestTask(WORKER_ID);
      if (!task) break;
      const digestSlot = task.digest_slot;
      if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(digestSlot || '')
          || typeof task.claim_token !== 'string') {
        await repository.retrySiteErrorDigestTask({ digestSlot, claimToken: task.claim_token, errorCode: 'digest_failed' });
        throw new Error('invalid site error digest claim');
      }
      try {
        const metrics = validateMetrics(await repository.getSiteErrorDigestMetrics());
        const categories = metrics.events.map(row => `${row.event_code}/${row.page_area}: ${row.occurrences}`).join('; ');
        const summary = `Проверка ошибок FAM за ${digestSlot} UTC: за 24 часа — ${metrics.total_events_24h}, за последний час — ${metrics.events_last_hour}. `
          + (categories ? `Категории: ${categories}. ` : '')
          + 'Сохранены только агрегированные коды ошибок и разделы; текст запросов и личные данные не читались.';
        const completed = await repository.completeSiteErrorDigestTask({ digestSlot, claimToken: task.claim_token, metrics, summary });
        if (!completed) throw new Error('site error digest lease expired');
        processedSlots.push(digestSlot);
        completedMetrics.push(metrics);
      } catch (error) {
        const errorCode = error?.message === 'invalid_metrics' ? 'invalid_metrics' : 'digest_failed';
        try { await repository.retrySiteErrorDigestTask({ digestSlot, claimToken: task.claim_token, errorCode }); } catch { /* lease expiry allows a later retry */ }
        throw error;
      }
    }
    return { processed: processedSlots.length > 0, processed_count: processedSlots.length,
      created: enqueue.created, slot: currentSlot, processed_slots: processedSlots, metrics: completedMetrics.at(-1) ?? null };
  };
}
