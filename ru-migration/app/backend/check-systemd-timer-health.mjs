import { pathToFileURL } from 'node:url';
import { checkSystemdTimerHealth } from './services/systemd-timer-health.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = checkSystemdTimerHealth();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}
