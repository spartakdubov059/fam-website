import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

export async function runSafeAgentWorker({ runtimeFactory = createRuntime } = {}) {
  const runtime = await runtimeFactory();
  if (typeof runtime?.runSafeAgentWorker !== 'function') throw new Error('FAM RU database and auth must be configured');
  try { return await runtime.runSafeAgentWorker(); }
  finally { await runtime.close?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runSafeAgentWorker();
    console.log(`SAFE_AGENT_WORKER: scheduled=${result.scheduled} created=${result.created} claimed=${result.claimed} completed=${result.completed} blocked=${result.blocked} failed=${result.failed} content_read=${result.content_read}`);
  } catch {
    console.error('SAFE_AGENT_WORKER: run failed; details and task contents are not logged.');
    process.exitCode = 1;
  }
}
