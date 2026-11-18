import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (!runtime?.getRuBackgroundQueueHealth) throw new Error('FAM RU database and auth must be configured');
  try {
    const report = await runtime.getRuBackgroundQueueHealth();
    console.log('RU_BACKGROUND_QUEUE_HEALTH: ' + JSON.stringify(report));
  } finally {
    await runtime.close();
  }
}
