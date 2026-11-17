import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (!runtime?.processOrchestratorDailyDigest) throw new Error('FAM RU database and auth must be configured');
  try {
    const result = await runtime.processOrchestratorDailyDigest();
    console.log(result.processed
      ? `ORCHESTRATOR_DAILY_DIGEST: processed=true date=${result.date}`
      : `ORCHESTRATOR_DAILY_DIGEST: processed=false date=${result.date}`);
  } finally {
    await runtime.close();
  }
}
