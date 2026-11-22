import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const timerDirectory = resolve(scriptDirectory, '../deploy/systemd');
const validateCalendars = !process.argv.includes('--structure-only');
const expectedCalendars = new Map([
  // The old global report timer is retained for traceability only, not deployment.
  ['fam-ru-orchestrator-daily-digest.timer', ['*-*-* 04:00:00 UTC']],
  ['fam-ru-coder-task-producer.timer', ['*-*-* 03:10:00 UTC']],
  ['fam-ru-pending-media-cleanup.timer', ['*-*-* 00,06,12,18:17:00 UTC']],
  ['fam-ru-runtime-health.timer', ['*-*-* 03:40:00 UTC']],
  ['fam-ru-safe-agent-worker.timer', ['*-*-* *:00,05,10,15,20,25,30,35,40,45,50,55:00 UTC']],
  ['fam-ru-school-agent-report.timer', ['*-*-* 03:30:00 UTC']],
  ['fam-ru-site-error-digest.timer', ['*-*-* *:30:00 UTC']],
]);
const timerNames = (await readdir(timerDirectory))
  .filter((name) => name.endsWith('.timer') && name !== 'fam-ru-agent-daily-report.timer')
  .sort();

if (timerNames.length === 0) {
  throw new Error('No FAM RU systemd timers were found.');
}
const expectedTimerNames = [...expectedCalendars.keys()].sort();
if (timerNames.length !== expectedTimerNames.length
    || timerNames.some((name, index) => name !== expectedTimerNames[index])) {
  throw new Error(`Timer inventory does not match the reviewed set: ${timerNames.join(', ')}`);
}

const historicalTimer = await readFile(join(timerDirectory, 'fam-ru-agent-daily-report.timer'), 'utf8');
if (!/Historical FAM RU global report timer; do not install or enable/.test(historicalTimer)
    || !/^Persistent=false$/m.test(historicalTimer)
    || !/^Unit=fam-ru-agent-daily-report\.service$/m.test(historicalTimer)
    || /^\[Install\]$/m.test(historicalTimer)) {
  throw new Error('Historical global daily report timer must remain retained but explicitly non-deployable.');
}

let usedSystemdCalendarParser = false;
let usedPortableCalendarParser = false;

for (const timerName of timerNames) {
  const timerPath = join(timerDirectory, timerName);
  const contents = await readFile(timerPath, 'utf8');
  const timerSection = contents.split(/^\[Timer\]\s*$/m)[1]?.split(/^\[/m)[0];
  if (!timerSection) {
    throw new Error(`${timerName}: missing [Timer] section.`);
  }

  const calendars = [...timerSection.matchAll(/^OnCalendar=(.+)$/gm)].map((match) => match[1].trim());
  if (calendars.length === 0 || calendars.some((calendar) => calendar.length === 0)) {
    throw new Error(`${timerName}: expected at least one non-empty OnCalendar value.`);
  }
  const expected = expectedCalendars.get(timerName);
  if (expected && (calendars.length !== expected.length || expected.some((calendar) => !calendars.includes(calendar)))) {
    throw new Error(`${timerName}: expected OnCalendar=${expected.join(' and OnCalendar=')}, got ${calendars.join(', ')}.`);
  }

  const serviceUnit = timerSection.match(/^Unit=(.+\.service)$/m)?.[1]?.trim();
  if (!serviceUnit || !(await fileExists(join(timerDirectory, serviceUnit)))) {
    throw new Error(`${timerName}: referenced service unit is missing.`);
  }

  for (const calendar of calendars) {
    if (!validateCalendars) continue;
    const result = spawnSync('systemd-analyze', ['calendar', '--iterations=1', calendar], {
      encoding: 'utf8',
    });
    if (result.error?.code === 'ENOENT') {
      if (!isSupportedPortableCalendar(calendar)) {
        throw new Error(`${timerName}: systemd-analyze is unavailable and calendar is outside the portable validator subset: ${calendar}`);
      }
      usedPortableCalendarParser = true;
      continue;
    }
    if (result.error || result.status !== 0) {
      const reason = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      throw new Error(`${timerName}: systemd rejected OnCalendar=${calendar}: ${reason}`);
    }
    usedSystemdCalendarParser = true;
  }
}

const errorDigest = await readFile(join(timerDirectory, 'fam-ru-site-error-digest.timer'), 'utf8');
if (!/^Persistent=false$/m.test(errorDigest)) {
  throw new Error('Site error digest must not catch up missed 15-minute timer events after downtime.');
}

const coderProducer = await readFile(join(timerDirectory, 'fam-ru-coder-task-producer.timer'), 'utf8');
if (!/^Persistent=false$/m.test(coderProducer)) {
  throw new Error('Coder task producer must not catch up a missed scheduled run after downtime.');
}

const safeAgentWorker = await readFile(join(timerDirectory, 'fam-ru-safe-agent-worker.timer'), 'utf8');
if (!/^Persistent=false$/m.test(safeAgentWorker)) {
  throw new Error('Safe agent worker must not catch up missed polling intervals after downtime.');
}

console.log(!validateCalendars
  ? `Validated ${timerNames.length} FAM RU timer files and service references; systemd calendar parsing was skipped.`
  : usedSystemdCalendarParser && usedPortableCalendarParser
    ? `Validated ${timerNames.length} FAM RU timer files; systemd and portable calendar parsers were both used.`
    : usedPortableCalendarParser
      ? `Validated ${timerNames.length} FAM RU timer files with the portable calendar subset parser; full systemd validation remains for Linux CI.`
      : `Validated ${timerNames.length} FAM RU timer files and their systemd calendar expressions.`);

function isSupportedPortableCalendar(calendar) {
  const match = calendar.match(/^\*-\*-\* ([^:\s]+):([^:\s]+):([^\s]+) UTC$/);
  if (!match) return false;
  const [hours, minutes, seconds] = match.slice(1);
  const validField = (value, min, max) => value === '*' || value.split(',').every((part) => {
    if (!/^\d{1,2}$/.test(part)) return false;
    const number = Number(part);
    return number >= min && number <= max;
  });
  return validField(hours, 0, 23) && validField(minutes, 0, 59) && validField(seconds, 0, 59);
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
