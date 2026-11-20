import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
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
import { createSafeAgentTaskWorker } from './services/safe-agent-task-worker.mjs';
import { createScheduledSafeAgentRunner } from './services/scheduled-safe-agent-runner.mjs';
import { checkSystemdTimerHealth } from './services/systemd-timer-health.mjs';
import { SCHOOL_CATALOG } from './policies/school-catalog.mjs';

export function getRuntimeReadiness({ yandexConfigured, oidcConfigured, databaseReady, mediaConfigured }) {
  const authConfigured = Boolean(yandexConfigured || oidcConfigured);
  const databaseAvailable = databaseReady === true;
  return {
    mode: 'isolated-copy',
    ready: authConfigured && databaseAvailable,
    services: { auth: authConfigured, database: databaseAvailable, objectStorage: Boolean(mediaConfigured) },
    message: yandexConfigured
      ? 'Russian backend is configured; optional media storage is reported separately.'
      : oidcConfigured
        ? 'Russian backend is configured with OIDC bearer authentication; optional media storage is reported separately.'
        : 'Yandex ID web authentication or OIDC bearer authentication is not configured.',
  };
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

export async function createRuntime(env = process.env) {
  const databaseUrl = env.FAM_RU_DATABASE_URL;
  const issuer = env.FAM_RU_AUTH_ISSUER;
  const audience = env.FAM_RU_AUTH_AUDIENCE;
  const jwksUri = env.FAM_RU_AUTH_JWKS_URL;
  const yandexConfigured = Boolean(env.FAM_RU_YANDEX_CLIENT_ID && env.FAM_RU_YANDEX_REDIRECT_URI && env.FAM_RU_SESSION_SECRET);
  const safetyKey = env.FAM_RU_SAFETY_HMAC_KEY || (yandexConfigured ? env.FAM_RU_SESSION_SECRET : null);
  const oidcConfigured = Boolean(issuer && audience && jwksUri);
  if (!databaseUrl || (!yandexConfigured && !oidcConfigured)) return null;
  const yandexAuth = yandexConfigured ? createYandexIdAuth({
    clientId: env.FAM_RU_YANDEX_CLIENT_ID,
    redirectUri: env.FAM_RU_YANDEX_REDIRECT_URI,
    sessionSecret: env.FAM_RU_SESSION_SECRET,
  }) : null;
  const authenticate = yandexAuth?.authenticate || createOidcBearerAuthenticator({ issuer, audience, jwksUri });
  const mediaConfigured = Boolean(env.FAM_RU_S3_ENDPOINT && env.FAM_RU_S3_BUCKET
    && env.FAM_RU_S3_ACCESS_KEY_ID && env.FAM_RU_S3_SECRET_ACCESS_KEY);
  const pendingImages = mediaConfigured ? createS3PendingImageStore(env) : null;
  const metadataEndpoint = env.FAM_RU_YDB_METADATA_URL;
  const credentialsProvider = new MetadataCredentialsProvider(metadataEndpoint ? { endpoint: metadataEndpoint, flavor: 'Google' } : {});
  const driver = new Driver(databaseUrl, { credentialsProvider });
  await driver.ready();
  const sql = query(driver);
  const probeYdbReadiness = createYdbReadinessProbe(sql);
  const resolveActor = createDatabaseActorResolver(sql);
  const repository = createYdbListingsRepository(sql);
  const agentTaskQueue = createYdbAgentTaskQueue(sql);
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
    system_health_check: async () => {
      const [readiness, timers] = await Promise.all([
        getRuntimeReadiness({ yandexConfigured: Boolean(yandexAuth), oidcConfigured, databaseReady: await probeYdbReadiness(), mediaConfigured }),
        Promise.resolve().then(() => checkSystemdTimerHealth()),
      ]);
      const timerRows = Array.isArray(timers?.timers) ? timers.timers : [];
      const healthyTimers = timerRows.filter(timer => timer?.ok === true).length;
      return `Техническая проверка FAM завершена. Готовность backend: ${readiness.ready ? 'да' : 'нет'}; исправны расписания: ${healthyTimers}/${timerRows.length}. Проверены только инфраструктурные признаки.`;
    },
    site_error_digest: async () => {
      const result = await createSiteErrorDigest({ repository })();
      return `Сводка ошибок FAM за UTC слот ${result.slot}: обработано ${result.processed_count} задач. Хранятся только агрегированные категории, без текста запросов и личных данных.`;
    },
  } });
  const runSafeAgentWorker = createScheduledSafeAgentRunner({ queue: agentTaskQueue, worker: processSafeAgentTasks });
  const guardSuspendedWrites = createSuspensionWriteGuard({ authenticate, resolveActor, repository });
  const listingsApi = guardSuspendedWrites(createListingsApi({ authenticate, resolveActor, repository, pendingImages, safetyKey }));
  const mediaApi = guardSuspendedWrites(createMediaApi({ authenticate, resolveActor, pendingImages, repository }));
  return {
    listingsApi,
    mediaApi,
    getReadiness: async () => getRuntimeReadiness({ yandexConfigured: Boolean(yandexAuth), oidcConfigured,
      databaseReady: await probeYdbReadiness(), mediaConfigured }),
    getRuBackgroundQueueHealth: async () => {
      const health = await repository.getRuBackgroundQueueHealth();
      return { ...health, queues: { ...health.queues, safe_agent_tasks: await agentTaskQueue.getSafeTaskQueueHealth() } };
    },
    cleanupPendingMedia: createPendingMediaCleanupOperation({ repository, pendingImages }),
    recoverAccountDeletions: createAccountDeletionRecoveryOperation({ repository, pendingImages }),
    refreshSchoolAgentReports: createSchoolAgentReports({ repository, schools: SCHOOL_CATALOG }),
    refreshAgentDailyReport: createAgentDailyReport({ repository }),
    processOrchestratorDailyDigest: createOrchestratorDailyDigest({ repository }),
    processSiteErrorDigest: createSiteErrorDigest({ repository }),
    agentTaskQueue,
    processSafeAgentTasks,
    runSafeAgentWorker,
    authApi: yandexAuth?.handle || null,
    close: async () => { pendingImages?.close?.(); await driver.close(); },
  };
}
