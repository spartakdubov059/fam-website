import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (!runtime?.refreshAgentDailyReport) throw new Error('FAM RU database and auth must be configured');
  try {
    const result = await runtime.refreshAgentDailyReport();
    console.log(`AGENT_DAILY_REPORT: refreshed=${result.refreshed} date=${result.date}`);
  } finally {
    await runtime.close();
  }
}
