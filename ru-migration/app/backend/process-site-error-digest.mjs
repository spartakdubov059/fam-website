import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (!runtime?.processSiteErrorDigest) throw new Error('FAM RU database and auth must be configured');
  try {
    const result = await runtime.processSiteErrorDigest();
    console.log(result.processed
      ? `SITE_ERROR_DIGEST: processed=true slot=${result.slot}`
      : `SITE_ERROR_DIGEST: processed=false slot=${result.slot}`);
  } finally {
    await runtime.close();
  }
}
