import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const timerDirectory = resolve(scriptDirectory, '../deploy/systemd');
const validateCalendars = !process.argv.includes('--structure-only');
const timerNames = (await readdir(timerDirectory))
  .filter((name) => name.endsWith('.timer'))
  .sort();

if (timerNames.length === 0) {
  throw new Error('No FAM RU systemd timers were found.');
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
