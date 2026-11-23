import { createRuntime } from './runtime.mjs';

const TIMER_EVENT_TYPE = 'yandex.cloud.events.serverless.triggers.TimerMessage';
const JOBS = Object.freeze({
  account_deletion_recovery: ['recoverAccountDeletions', true],
  coder_task_producer: ['enqueueSafeCoderTask', false],
  orchestrator_daily_digest: ['processOrchestratorDailyDigest', false],
  pending_media_cleanup: ['cleanupPendingMedia', true],
  runtime_health: [null, true],
  safe_agent_worker: ['runSafeAgentWorker', false],
  school_agent_report: ['refreshSchoolAgentReports', false],
  site_error_digest: ['processSiteErrorDigest', false],
});

function readConfig(env) {
  let triggerJobs;
  try { triggerJobs = JSON.parse(env.FAM_RU_TIMER_TRIGGER_JOB_MAP || ''); }
  catch { throw new Error('invalid timer configuration'); }
  if (!triggerJobs || typeof triggerJobs !== 'object' || Array.isArray(triggerJobs)
      || Object.getPrototypeOf(triggerJobs) !== Object.prototype || Object.keys(triggerJobs).length < 1
      || Object.keys(triggerJobs).length > 32) throw new Error('invalid timer configuration');
  for (const [triggerId, job] of Object.entries(triggerJobs)) {
    if (!/^[a-zA-Z0-9-]{6,80}$/.test(triggerId) || typeof job !== 'string' || !Object.hasOwn(JOBS, job)) {
      throw new Error('invalid timer configuration');
    }
  }
  const cloudId = env.FAM_RU_CLOUD_ID;
  const folderId = env.FAM_RU_FOLDER_ID;
  if (typeof cloudId !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(cloudId)
      || typeof folderId !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(folderId)) {
    throw new Error('invalid timer configuration');
  }
  return { triggerJobs, cloudId, folderId };
}

function readInvocation(event, config) {
  if (!event || !Array.isArray(event.messages) || event.messages.length !== 1) throw new Error('timer event rejected');
  const message = event.messages[0];
  const metadata = message?.event_metadata;
  const details = message?.details;
  if (metadata?.event_type !== TIMER_EVENT_TYPE || metadata.cloud_id !== config.cloudId
      || metadata.folder_id !== config.folderId || typeof details?.trigger_id !== 'string') {
    throw new Error('timer event rejected');
  }
  const job = config.triggerJobs[details.trigger_id];
  if (!job || details.payload !== job) throw new Error('timer event rejected');
  return job;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function summarize(job, result) {
  switch (job) {
    case 'account_deletion_recovery':
    case 'pending_media_cleanup':
      return { claimed: nonNegativeInteger(result?.claimed), completed: nonNegativeInteger(result?.completed),
        deleted: nonNegativeInteger(result?.deleted), failed: nonNegativeInteger(result?.failed) };
    case 'coder_task_producer':
      return { created: result?.created === true, content_read: result?.content_read !== false };
    case 'orchestrator_daily_digest':
      return { processed: result?.processed === true, created: result?.created === true,
        date: typeof result?.date === 'string' ? result.date : null };
    case 'safe_agent_worker':
      return { scheduled: nonNegativeInteger(result?.scheduled), created: nonNegativeInteger(result?.created),
        claimed: nonNegativeInteger(result?.claimed), completed: nonNegativeInteger(result?.completed),
        blocked: nonNegativeInteger(result?.blocked), failed: nonNegativeInteger(result?.failed),
        content_read: result?.content_read !== false };
    case 'school_agent_report':
      return { refreshed: nonNegativeInteger(result?.refreshed) };
    case 'site_error_digest':
      return { processed: result?.processed === true, processed_count: nonNegativeInteger(result?.processed_count),
        slot: typeof result?.slot === 'string' ? result.slot : null };
    default:
      throw new Error('timer job unavailable');
  }
}

export function createYandexTimerHandler({ env = process.env, runtimeFactory = createRuntime } = {}) {
  if (!env || typeof env !== 'object' || typeof runtimeFactory !== 'function') throw new TypeError('timer dependencies are required');
  return async function handleYandexTimer(event) {
    const config = readConfig(env);
    const job = readInvocation(event, config);
    const [method, needsMedia] = JOBS[job];
    let runtime;
    try {
      runtime = await runtimeFactory(env, { allowBackgroundJobsOnly: true });
      if (!runtime) throw new Error('timer runtime unavailable');
      if (job === 'runtime_health') {
        const ready = await runtime.getBackgroundReadiness?.();
        if (ready?.database !== true || ready?.objectStorageConfigured !== true) throw new Error('timer readiness failed');
        return { ok: true, job, result: { database: true, objectStorageConfigured: true } };
      }
      if (typeof runtime[method] !== 'function') throw new Error('timer runtime unavailable');
      if (needsMedia) {
        const ready = await runtime.getBackgroundReadiness?.();
        if (ready?.database !== true || ready?.objectStorageConfigured !== true) throw new Error('timer media configuration unavailable');
      }
      const result = await runtime[method](job === 'account_deletion_recovery' ? 10 : undefined);
      return { ok: true, job, result: summarize(job, result) };
    } catch {
      throw new Error(`FAM_RU_TIMER_JOB_FAILED:${job}`);
    } finally {
      try { await runtime?.close?.(); } catch { /* Do not leak runtime internals to the invocation response. */ }
    }
  };
}

const defaultHandler = createYandexTimerHandler();
export const handler = event => defaultHandler(event);
