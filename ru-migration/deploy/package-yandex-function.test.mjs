import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageFunction } from './package-yandex-function.mjs';

const execFileAsync = promisify(execFile);

test('Yandex Function archive uses tracked app files and excludes workspace copies', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'fam-ru-ycf-package-test-'));
  const output = path.join(temp, 'function.zip');
  try {
    const result = await packageFunction(output);
    assert.equal(result.runtime, 'nodejs22');
    assert.deepEqual(result.entrypoints, ['index.handler', 'timer.handler']);
    assert.ok(result.bytes <= 3.5 * 1024 * 1024);

    const { stdout } = await execFileAsync('unzip', ['-Z1', output]);
    const names = new Set(stdout.split('\n').filter(Boolean));
    for (const required of [
      'index.cjs', 'timer.cjs', 'package.json', 'package-lock.json',
      'app/backend/yandex-function.mjs', 'app/backend/schema/37_step_up_email_challenges.yql',
      'app/web/index.html', 'app/web/step-up-email.js',
      ...Array.from({ length: 12 }, (_, index) => `app/web/assets/banner-${index + 1}.webp`),
    ]) assert.ok(names.has(required), `archive is missing ${required}`);
    for (const excluded of [
      'app/backend/schema/37_step_up_email_challenges 2.yql',
      'app/web/step-up-email 2.js',
    ]) assert.equal(names.has(excluded), false, `archive includes untracked workspace copy ${excluded}`);
    assert.equal([...names].some(name => /(^|\/)(?:node_modules|test|\.git)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key)$/i.test(name)), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
