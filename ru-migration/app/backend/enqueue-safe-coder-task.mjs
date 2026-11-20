import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (typeof runtime?.enqueueSafeCoderTask !== 'function') throw new Error('FAM RU database must be configured');
  try {
    const result = await runtime.enqueueSafeCoderTask();
    console.log(`SAFE_CODER_TASK: created=${result.created} reason=${result.reason} content_read=${result.content_read}`);
  } catch {
    console.error('SAFE_CODER_TASK: failed');
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
