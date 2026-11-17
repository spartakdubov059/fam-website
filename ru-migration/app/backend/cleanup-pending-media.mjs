import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime();
  if (!runtime?.cleanupPendingMedia) throw new Error('FAM RU database, auth, and private image storage must be configured');
  try {
    const result = await runtime.cleanupPendingMedia();
    console.log(`PENDING_MEDIA_CLEANUP: claimed=${result.claimed} deleted=${result.deleted} failed=${result.failed}`);
    if (result.failed) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
