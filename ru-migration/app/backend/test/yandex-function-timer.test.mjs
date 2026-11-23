import test from 'node:test';
import assert from 'node:assert/strict';
import { createYandexTimerHandler } from '../yandex-function-timer.mjs';

const ENV = {
  FAM_RU_CLOUD_ID: 'b1g-cloud-123456',
  FAM_RU_FOLDER_ID: 'b1g-folder-123456',
  FAM_RU_TIMER_TRIGGER_JOB_MAP: JSON.stringify({ 'a1s-trigger-123456': 'safe_agent_worker' }),
};

function timerEvent({ triggerId = 'a1s-trigger-123456', job = 'safe_agent_worker', metadata = {} } = {}) {
  return { messages: [{ event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage',
    cloud_id: ENV.FAM_RU_CLOUD_ID, folder_id: ENV.FAM_RU_FOLDER_ID, ...metadata },
  details: { trigger_id: triggerId, payload: job } }] };
}

test('Yandex timer dispatches only the configured allowlisted job and returns a bounded summary', async () => {
  let calls = 0;
  let closed = false;
  const handler = createYandexTimerHandler({ env: ENV, runtimeFactory: async (_env, options) => {
    assert.equal(options.allowBackgroundJobsOnly, true);
    return { runSafeAgentWorker: async () => {
      calls++;
      return { scheduled: 1, created: 1, claimed: 2, completed: 1, blocked: 0, failed: 1,
        content_read: false, sensitive_payload: 'must not escape' };
    }, close: async () => { closed = true; } };
  } });

  const result = await handler(timerEvent());
  assert.deepEqual(result, { ok: true, job: 'safe_agent_worker', result: {
    scheduled: 1, created: 1, claimed: 2, completed: 1, blocked: 0, failed: 1, content_read: false,
  } });
  assert.equal(calls, 1);
  assert.equal(closed, true);
});

test('Yandex timer rejects non-timer, wrong-cloud, wrong-folder, unknown-trigger, and mismatched-payload events before runtime setup', async () => {
  let runtimeCalls = 0;
  const handler = createYandexTimerHandler({ env: ENV, runtimeFactory: async () => { runtimeCalls++; return {}; } });
  const rejected = [
    { ...timerEvent(), messages: [] },
    timerEvent({ metadata: { event_type: 'http.request' } }),
    timerEvent({ metadata: { cloud_id: 'b1g-other-cloud' } }),
    timerEvent({ metadata: { folder_id: 'b1g-other-folder' } }),
    timerEvent({ triggerId: 'a1s-unknown-trigger', job: 'safe_agent_worker' }),
    timerEvent({ job: 'pending_media_cleanup' }),
  ];
  for (const event of rejected) await assert.rejects(handler(event), /timer event rejected/);
  assert.equal(runtimeCalls, 0);
});

test('Yandex timer requires database and configured private storage before any media cleanup or deletion recovery', async () => {
  for (const job of ['pending_media_cleanup', 'account_deletion_recovery', 'runtime_health']) {
    const triggerId = job === 'pending_media_cleanup' ? 'a1s-pending-123456'
      : job === 'account_deletion_recovery' ? 'a1s-recovery-123456' : 'a1s-health-123456';
    const env = { ...ENV, FAM_RU_TIMER_TRIGGER_JOB_MAP: JSON.stringify({ [triggerId]: job }) };
    let jobCalled = false;
    const handler = createYandexTimerHandler({ env, runtimeFactory: async () => ({
      getBackgroundReadiness: async () => ({ database: true, objectStorageConfigured: false }),
      cleanupPendingMedia: async () => { jobCalled = true; return {}; },
      recoverAccountDeletions: async () => { jobCalled = true; return {}; },
      close: async () => {},
    }) });
    await assert.rejects(handler(timerEvent({ triggerId, job })), /FAM_RU_TIMER_JOB_FAILED/);
    assert.equal(jobCalled, false);
  }
});

test('Yandex background health runs without end-user OAuth secrets and reports configuration separately from live status', async () => {
  const triggerId = 'a1s-health-123456';
  const env = { ...ENV, FAM_RU_TIMER_TRIGGER_JOB_MAP: JSON.stringify({ [triggerId]: 'runtime_health' }) };
  const handler = createYandexTimerHandler({ env, runtimeFactory: async (_env, options) => {
    assert.equal(options.allowBackgroundJobsOnly, true);
    return { getBackgroundReadiness: async () => ({ database: true, objectStorageConfigured: true }), close: async () => {} };
  } });
  const result = await handler(timerEvent({ triggerId, job: 'runtime_health' }));
  assert.deepEqual(result, { ok: true, job: 'runtime_health', result: { database: true, objectStorageConfigured: true } });
  assert.equal(env.FAM_RU_YANDEX_CLIENT_ID, undefined);
  assert.equal(env.FAM_RU_SESSION_SECRET, undefined);
});

test('Yandex timer closes a job runtime and hides failures', async () => {
  let closed = false;
  const triggerId = 'a1s-orchestrator-123456';
  const env = { ...ENV, FAM_RU_TIMER_TRIGGER_JOB_MAP: JSON.stringify({ [triggerId]: 'orchestrator_daily_digest' }) };
  const handler = createYandexTimerHandler({ env, runtimeFactory: async () => ({
    processOrchestratorDailyDigest: async () => { throw new Error('private database detail'); },
    close: async () => { closed = true; },
  }) });
  await assert.rejects(handler(timerEvent({ triggerId, job: 'orchestrator_daily_digest' })), error => {
    assert.equal(error.message, 'FAM_RU_TIMER_JOB_FAILED:orchestrator_daily_digest');
    assert.doesNotMatch(error.message, /private database detail/);
    return true;
  });
  assert.equal(closed, true);
});

test('Yandex timer rejects malformed trigger maps and cloud scope', async () => {
  const invalidConfigs = [
    { ...ENV, FAM_RU_TIMER_TRIGGER_JOB_MAP: '{' },
    { ...ENV, FAM_RU_TIMER_TRIGGER_JOB_MAP: JSON.stringify({ 'a1s-trigger-123456': 'unknown_job' }) },
    { ...ENV, FAM_RU_FOLDER_ID: '' },
  ];
  for (const env of invalidConfigs) {
    const handler = createYandexTimerHandler({ env, runtimeFactory: async () => assert.fail('runtime must not start') });
    await assert.rejects(handler(timerEvent()), /invalid timer configuration/);
  }
});
