import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Driver } from '@ydbjs/core';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from './repositories/ydb-listings.mjs';

const CONFIRMATION = 'I_CONFIRM_ONE_TIME_INITIAL_ADMIN_SETUP';
if (process.env.FAM_RU_ALLOW_INITIAL_ADMIN_BOOTSTRAP !== CONFIRMATION) {
  console.error('Bootstrap disabled. Set the exact one-time confirmation environment value to continue.');
  process.exit(2);
}
const databaseUrl = process.env.FAM_RU_DATABASE_URL;
if (!databaseUrl) {
  console.error('FAM_RU_DATABASE_URL is required.');
  process.exit(2);
}

const prompt = createInterface({ input: stdin, output: stdout });
let driver;
try {
  console.log('This creates the first school administrator in one Russian FAM school. It cannot be repeated for that school.');
  const schoolId = (await prompt.question('School ID (lyceum_3 or gymnasium_4): ')).trim();
  const subject = (await prompt.question('Verified numeric Yandex ID subject: ')).trim();
  const firstName = (await prompt.question('First name: ')).trim();
  const lastName = (await prompt.question('Last name: ')).trim();
  if (!['lyceum_3', 'gymnasium_4'].includes(schoolId) || !/^\d{1,32}$/.test(subject)
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
    issuer: 'https://login.yandex.ru', subject, userId: randomUUID(), schoolId, firstName, lastName,
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
