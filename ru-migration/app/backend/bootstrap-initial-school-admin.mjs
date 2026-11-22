import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Driver } from '@ydbjs/core';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { query } from '@ydbjs/query';
import { resolveYandexIdentityFromAccessToken } from './auth/yandex-access-token.mjs';
import { createYdbListingsRepository } from './repositories/ydb-listings.mjs';

const CONFIRMATION = 'I_CONFIRM_ONE_TIME_INITIAL_ADMIN_SETUP';
if (process.env.FAM_RU_ALLOW_INITIAL_ADMIN_BOOTSTRAP !== CONFIRMATION) {
  console.error('Bootstrap disabled. Set the exact one-time confirmation environment value to continue.');
  process.exit(2);
}
const databaseUrl = process.env.FAM_RU_DATABASE_URL;
const clientId = process.env.FAM_RU_YANDEX_CLIENT_ID;
if (!databaseUrl || !clientId) {
  console.error('FAM_RU_DATABASE_URL and FAM_RU_YANDEX_CLIENT_ID are required.');
  process.exit(2);
}

function readHidden(promptText) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('interactive_terminal_required');
  stdout.write(promptText);
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = '';
    const finish = (error = null) => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return finish(new Error('input_cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && character !== '\u007f') value += character;
        if (value.length > 4096) return finish(new Error('input_too_long'));
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

const prompt = createInterface({ input: stdin, output: stdout });
let driver;
try {
  console.log('This creates the first school administrator in one Russian FAM school. It cannot be repeated for that school.');
  const schoolId = (await prompt.question('School ID (lyceum_3 or gymnasium_4): ')).trim();
  const firstName = (await prompt.question('First name: ')).trim();
  const lastName = (await prompt.question('Last name: ')).trim();
  prompt.close();
  const accessToken = await readHidden('Temporary Yandex OAuth access token (input hidden): ');
  const identity = await resolveYandexIdentityFromAccessToken({ accessToken, clientId });
  if (!['lyceum_3', 'gymnasium_4'].includes(schoolId)
      || !firstName || firstName.length > 80 || !lastName || lastName.length > 80) {
    throw new Error('invalid_operator_input');
  }
  driver = new Driver(databaseUrl, { credentialsProvider: new MetadataCredentialsProvider(
    process.env.FAM_RU_YDB_METADATA_URL
      ? { endpoint: process.env.FAM_RU_YDB_METADATA_URL, flavor: 'Google' }
      : {},
  ) });
  await driver.ready();
  const repository = createYdbListingsRepository(query(driver));
  const result = await repository.bootstrapInitialSchoolAdmin({
    ...identity, userId: randomUUID(), schoolId, firstName, lastName,
  });
  if (!result.ok) {
    console.error(`Bootstrap refused: ${result.code}`);
    process.exitCode = 1;
  } else {
    console.log('Initial school administrator created. No account identifier or profile data was printed.');
  }
} catch {
  console.error('Bootstrap failed. No account or profile values were printed.');
  process.exitCode = 1;
} finally {
  prompt.close();
  await driver?.close();
}
