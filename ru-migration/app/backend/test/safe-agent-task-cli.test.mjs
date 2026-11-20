import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueSafeAgentTask } from '../enqueue-safe-agent-task.mjs';
import { processSafeAgentTasks } from '../process-safe-agent-tasks.mjs';
import { runSafeAgentWorker } from '../run-safe-agent-worker.mjs';

test('safe agent queue CLIs close the runtime after success and failure', async () => {
  let closes = 0;
  const runtimeFactory = async () => ({ agentTaskQueue: { enqueueSafeTask: async (...args) => ({ created: true, args }) },
    processSafeAgentTasks: async limit => ({ claimed: limit }), close: async () => { closes++; } });
  assert.deepEqual(await enqueueSafeAgentTask({ runtimeFactory, taskType: 'site_error_digest', slot: '2026-11-20T03:15' }),
    { created: true, args: ['site_error_digest', '2026-11-20T03:15'] });
  assert.deepEqual(await processSafeAgentTasks({ runtimeFactory, limit: 2 }), { claimed: 2 });
  assert.deepEqual(await runSafeAgentWorker({ runtimeFactory: async () => ({ runSafeAgentWorker: async () => ({ claimed: 0 }), close: async () => { closes++; } }) }), { claimed: 0 });
  assert.equal(closes, 3);
  const failingFactory = async () => ({ agentTaskQueue: { enqueueSafeTask: async () => { throw new Error('sensitive'); } },
    close: async () => { closes++; } });
  await assert.rejects(enqueueSafeAgentTask({ runtimeFactory: failingFactory, taskType: 'queue_health_check', slot: '2026-11-20T03:00' }));
  assert.equal(closes, 4);
});
