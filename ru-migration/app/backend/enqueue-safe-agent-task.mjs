import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

export async function enqueueSafeAgentTask({ runtimeFactory = createRuntime, taskType, slot } = {}) {
  const runtime = await runtimeFactory();
  if (typeof runtime?.agentTaskQueue?.enqueueSafeTask !== 'function') throw new Error('FAM RU database and auth must be configured');
  try { return await runtime.agentTaskQueue.enqueueSafeTask(taskType, slot); }
  finally { await runtime.close?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , taskType, slot] = process.argv;
  try {
    const result = await enqueueSafeAgentTask({ taskType, slot });
    console.log(`SAFE_AGENT_TASK: type=${taskType} created=${result.created} status=${result.status}`);
  } catch {
    console.error('SAFE_AGENT_TASK: enqueue failed; details are not logged.');
    process.exitCode = 1;
  }
}
