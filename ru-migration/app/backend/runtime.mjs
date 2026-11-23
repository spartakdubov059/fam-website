import { Driver } from '@ydbjs/core';
import { query, identifier, fragment, join } from '@ydbjs/query';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { createOidcBearerAuthenticator } from './auth/oidc-bearer.mjs';
import { createDatabaseActorResolver } from './auth/database-actor.mjs';
import { createSuspensionWriteGuard } from './auth/suspension-write-guard.mjs';
import { createYandexIdAuth } from './auth/yandex-id.mjs';
import { createYdbListingsRepository } from './repositories/ydb-listings.mjs';
import { createYdbAgentTaskQueue } from './repositories/ydb-agent-task-queue.mjs';
import { createListingsApi } from './services/listings-api.mjs';
import { createMediaApi } from './services/media-api.mjs';
import { createS3PendingImageStore } from './media/s3-pending-store.mjs';
import { createPendingMediaCleanupOperation } from './services/cleanup-pending-media.mjs';
import { createAccountDeletionRecoveryOperation } from './services/recover-account-deletions.mjs';
import { createSchoolAgentReports } from './services/school-agent-reports.mjs';
import { createAgentDailyReport } from './services/agent-daily-report.mjs';
import { createOrchestratorDailyDigest } from './services/orchestrator-daily-digest.mjs';
import { createSiteErrorDigest } from './services/site-error-digest.mjs';
import { createSystemHealthTaskHandler } from './services/system-health-task.mjs';
import { createBackgroundSystemHealthTask } from './services/background-system-health.mjs';
import { createSafeAgentTaskWorker } from './services/safe-agent-task-worker.mjs';
import { createCoderTaskBridge } from './services/coder-task-bridge.mjs';
import { createScheduledSafeAgentRunner, createScheduledCoderTaskProducer } from './services/scheduled-safe-agent-runner.mjs';
import { checkSystemdTimerHealth } from './services/systemd-timer-health.mjs';
import { createYdbSchemaHealthCheck } from './services/ydb-schema-health.mjs';
import { createYandexPostboxSender } from './services/yandex-postbox.mjs';
import { createStepUpCookie } from './auth/step-up-cookie.mjs';
import { SCHOOL_CATALOG } from './policies/school-catalog.mjs';

export function getRuntimeReadiness({ yandexConfigured, oidcConfigured, databaseReady, mediaConfigured }) {
  const authConfigured = Boolean(yandexConfigured || oidcConfigured);
  const databaseAvailable = databaseReady === true;
  const objectStorageAvailable = mediaConfigured === true;
  return {
    mode: 'isolated-copy',
    ready: authConfigured && databaseAvailable && objectStorageAvailable,
    services: { auth: authConfigured, database: databaseAvailable, objectStorage: objectStorageAvailable },
    message: !authConfigured
      ? 'Yandex ID web authentication or OIDC bearer authentication is not configured.'
      : !databaseAvailable
        ? 'Russian backend database is not ready.'
        : !objectStorageAvailable
          ? 'Russian object storage is not configured.'
          : yandexConfigured
            ? 'Russian backend, database, and object storage are configured.'
            : 'Russian backend, database, and object storage are configured with OIDC bearer authentication.',
  };
}

export function getAuthConfiguration(env = {}) {
  const yandexValues = [env.FAM_RU_YANDEX_CLIENT_ID, env.FAM_RU_YANDEX_REDIRECT_URI, env.FAM_RU_SESSION_SECRET];
  const oidcValues = [env.FAM_RU_AUTH_ISSUER, env.FAM_RU_AUTH_AUDIENCE, env.FAM_RU_AUTH_JWKS_URL];
  const yandexPresent = yandexValues.some(Boolean);
  const oidcPresent = oidcValues.some(Boolean);
  const yandexConfigured = yandexValues.every(Boolean);
  const oidcConfigured = oidcValues.every(Boolean);
  if (yandexPresent && oidcPresent) return { valid: false, reason: 'conflicting_auth_modes' };
  if ((yandexPresent && !yandexConfigured) || (oidcPresent && !oidcConfigured)) {
    return { valid: false, reason: 'incomplete_auth_configuration' };
  }
  return { valid: true, yandexConfigured, oidcConfigured };
}

export async function checkYdbReadiness(sql) {
  if (typeof sql !== 'function') return false;
  try {
    await sql`SELECT 1 AS ready;`;
    return true;
  } catch {
    return false;
  }
}

export function createYdbReadinessProbe(sql, { cacheMs = 5000, now = () => Date.now() } = {}) {
  if (typeof sql !== 'function' || !Number.isSafeInteger(cacheMs) || cacheMs < 1000 || cacheMs > 30_000
      || typeof now !== 'function') throw new TypeError('invalid YDB readiness probe configuration');
  let cachedAt = 0;
  let cachedValue = null;
  let inFlight = null;
  return async function probeYdbReadiness() {
    const current = now();
    if (cachedValue !== null && current >= cachedAt && current - cachedAt < cacheMs) return cachedValue;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      cachedValue = await checkYdbReadiness(sql);
      cachedAt = now();
      return cachedValue;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };
}

export async function createRuntime(env = process.env, { allowBackgroundJobsOnly = false } = {}) {
  const databaseUrl = env.FAM_RU_DATABASE_URL;
  const issuer = env.FAM_RU_AUTH_ISSUER;
  const audience = env.FAM_RU_AUTH_AUDIENCE;
  const jwksUri = env.FAM_RU_AUTH_JWKS_URL;
  const authConfig = getAuthConfiguration(env);
  if (!authConfig.valid && allowBackgroundJobsOnly !== true) return null;
  const yandexConfigured = authConfig.valid && authConfig.yandexConfigured;
  const safetyKey = env.FAM_RU_SAFETY_HMAC_KEY || (yandexConfigured ? env.FAM_RU_SESSION_SECRET : null);
  const oidcConfigured = authConfig.valid && authConfig.oidcConfigured;
  if (!databaseUrl || (!yandexConfigured && !oidcConfigured && allowBackgroundJobsOnly !== true)) return null;
  const yandexAuth = yandexConfigured ? createYandexIdAuth({
    clientId: env.FAM_RU_YANDEX_CLIENT_ID,
    redirectUri: env.FAM_RU_YANDEX_REDIRECT_URI,
    sessionSecret: env.FAM_RU_SESSION_SECRET,
  }) : null;
  const authenticate = yandexAuth?.authenticate || (oidcConfigured
    ? createOidcBearerAuthenticator({ issuer, audience, jwksUri })
    : async () => null);
  const mediaConfigured = Boolean(env.FAM_RU_S3_ENDPOINT && env.FAM_RU_S3_BUCKET
    && env.FAM_RU_S3_ACCESS_KEY_ID && env.FAM_RU_S3_SECRET_ACCESS_KEY);
  const pendingImages = mediaConfigured ? createS3PendingImageStore(env) : null;
  const metadataEndpoint = env.FAM_RU_YDB_METADATA_URL;
  const credentialsProvider = new MetadataCredentialsProvider(metadataEndpoint ? { endpoint: metadataEndpoint, flavor: 'Google' } : {});
  const driver = new Driver(databaseUrl, { credentialsProvider });
  await driver.ready();
  const sql = query(driver);
  const probeYdbReadiness = createYdbReadinessProbe(sql);
  const schemaHealthCheck = createYdbSchemaHealthCheck(sql, { identifier, fragment, join });
  const resolveActor = createDatabaseActorResolver(sql);
  const repository = createYdbListingsRepository(sql);
  const sendRoleVerificationEmail = createYandexPostboxSender({ fromEmail: env.FAM_RU_POSTBOX_FROM_EMAIL });
  const stepUpCookie = yandexAuth ? createStepUpCookie({ secret: env.FAM_RU_SESSION_SECRET,
    secure: new URL(env.FAM_RU_YANDEX_REDIRECT_URI).protocol === 'https:' }) : null;
  const agentTaskQueue = createYdbAgentTaskQueue(sql);
  const coderTaskBridge = createCoderTaskBridge({ queue: agentTaskQueue, token: env.FAM_RU_CODER_WORKER_TOKEN });
  const queueHealthCheck = async () => {
    const [health, safeAgentTasks] = await Promise.all([
      repository.getRuBackgroundQueueHealth(), agentTaskQueue.getSafeTaskQueueHealth(),
    ]);
    return { ...health, queues: { ...health.queues, safe_agent_tasks: safeAgentTasks },
      content_read: health.content_read === false && safeAgentTasks.content_read === false };
  };
  const systemHealthTask = allowBackgroundJobsOnly
    ? createBackgroundSystemHealthTask({ databaseCheck: probeYdbReadiness, schemaCheck: schemaHealthCheck, queueHealthCheck })
    : createSystemHealthTaskHandler({
      readinessCheck: async () => getRuntimeReadiness({ yandexConfigured: Boolean(yandexAuth), oidcConfigured,
        databaseReady: await probeYdbReadiness(), mediaConfigured }),
      timerCheck: checkSystemdTimerHealth,
      schemaCheck: schemaHealthCheck,
      queueHealthCheck,
    });
  const processSafeAgentTasks = createSafeAgentTaskWorker({ queue: agentTaskQueue, handlers: {
    queue_health_check: async () => {
      const health = await agentTaskQueue.getSafeTaskQueueHealth();
      if (health?.content_read !== false || !health.statuses) throw new Error('queue_health_unavailable');
      return `Проверка очереди завершена. Задач ожидают: ${health.statuses.queued}; просроченных lease: ${health.expired_leases}; неуспешных задач за сутки: ${health.failed_or_blocked_24h}. Пользовательское содержимое не читалось.`;
    },
    daily_report_digest: async () => {
      const result = await createOrchestratorDailyDigest({ repository })();
      return `Операционная сводка FAM за ${result.date}: ${result.processed ? 'обработана' : 'уже актуальна или ожидает повторного запуска'}. Использованы только агрегированные показатели.`;
    },
    system_health_check: systemHealthTask,
    site_error_digest: async () => {
      const result = await createSiteErrorDigest({ repository })();
      return `Сводка ошибок FAM за UTC слот ${result.slot}: обработано ${result.processed_count} задач. Хранятся только агрегированные категории, без текста запросов и личных данных.`;
    },
  } });
  const runSafeAgentWorker = createScheduledSafeAgentRunner({ queue: agentTaskQueue, worker: processSafeAgentTasks });
  const enqueueSafeCoderTask = createScheduledCoderTaskProducer({ repository: {
    enqueueSafeCoderTask: slot => agentTaskQueue.enqueueSafeCoderTask(slot),
  } });
  const guardSuspendedWrites = createSuspensionWriteGuard({ authenticate, resolveActor, repository });
  const listingsApi = guardSuspendedWrites(createListingsApi({ authenticate, resolveActor, repository, pendingImages, safetyKey,
    verificationKey: env.FAM_RU_SESSION_SECRET, sendRoleVerificationEmail, sendStepUpEmail: sendRoleVerificationEmail,
    stepUpCookie, authenticate: async req => {
      const identity = await authenticate(req);
      if (!identity || !stepUpCookie) return identity;
      const stepUpAt = stepUpCookie.read(req, identity);
      return stepUpAt ? { ...identity, step_up_confirmed_at: stepUpAt } : identity;
    } }));
  const mediaApi = guardSuspendedWrites(createMediaApi({ authenticate, resolveActor, pendingImages, repository }));
  return {
    listingsApi,
    mediaApi,
    getReadiness: async () => getRuntimeReadiness({ yandexConfigured: Boolean(yandexAuth), oidcConfigured,
      databaseReady: await probeYdbReadiness(), mediaConfigured }),
    getBackgroundReadiness: async () => ({ database: await probeYdbReadiness(), objectStorageConfigured: mediaConfigured }),
    getRuBackgroundQueueHealth: async () => {
      const health = await repository.getRuBackgroundQueueHealth();
      return { ...health, queues: { ...health.queues, safe_agent_tasks: await agentTaskQueue.getSafeTaskQueueHealth() } };
    },
    getRuSchemaHealth: schemaHealthCheck,
    cleanupPendingMedia: createPendingMediaCleanupOperation({ repository, pendingImages }),
    recoverAccountDeletions: createAccountDeletionRecoveryOperation({ repository, pendingImages }),
    refreshSchoolAgentReports: createSchoolAgentReports({ repository, schools: SCHOOL_CATALOG }),
    refreshAgentDailyReport: createAgentDailyReport({ repository }),
    processOrchestratorDailyDigest: createOrchestratorDailyDigest({ repository }),
    processSiteErrorDigest: createSiteErrorDigest({ repository }),
    agentTaskQueue,
    coderTaskBridge,
    processSafeAgentTasks,
    runSafeAgentWorker,
    enqueueSafeCoderTask,
    authApi: yandexAuth?.handle || null,
    close: async () => { pendingImages?.close?.(); await driver.close(); },
  };
}
