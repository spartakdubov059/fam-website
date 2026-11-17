import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (!runtime?.refreshSchoolAgentReports) throw new Error('FAM RU database and auth must be configured');
  try {
    const result = await runtime.refreshSchoolAgentReports();
    console.log(`SCHOOL_AGENT_REPORTS: refreshed=${result.refreshed}`);
  } finally {
    await runtime.close();
  }
}
