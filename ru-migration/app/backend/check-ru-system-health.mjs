import { pathToFileURL } from 'node:url';
import { checkRuntimeHealth } from './check-runtime-health.mjs';
import { checkSystemdTimerHealth } from './services/systemd-timer-health.mjs';
import { buildRuSystemHealthReport } from './services/ru-system-health.mjs';
import { createRuntime } from './runtime.mjs';

export async function checkRuSystemHealth({ runtimeFactory = createRuntime,
  readinessCheck = checkRuntimeHealth, timerCheck = checkSystemdTimerHealth } = {}) {
  const [readiness, timers] = await Promise.all([
    Promise.resolve().then(() => readinessCheck()).catch(() => ({ ready: false, services: {} })),
    Promise.resolve().then(() => timerCheck()).catch(() => ({ ok: false, timers: [] })),
  ]);
  let runtime;
  let backgroundQueueHealth = null;
  let schemaHealth = null;
  try {
    runtime = await runtimeFactory();
    const [queueResult, schemaResult] = await Promise.all([
      typeof runtime?.getRuBackgroundQueueHealth === 'function'
        ? Promise.resolve().then(() => runtime.getRuBackgroundQueueHealth()).catch(() => null) : null,
      typeof runtime?.getRuSchemaHealth === 'function'
        ? Promise.resolve().then(() => runtime.getRuSchemaHealth()).catch(() => null) : null,
    ]);
    backgroundQueueHealth = queueResult;
    schemaHealth = schemaResult;
  } catch {
    backgroundQueueHealth = null;
    schemaHealth = null;
  } finally {
    try { await runtime?.close?.(); } catch { /* A read-only health report must not leak shutdown errors. */ }
  }
  return buildRuSystemHealthReport({ readiness, timers, backgroundQueueHealth, schemaHealth });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await checkRuSystemHealth();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}
