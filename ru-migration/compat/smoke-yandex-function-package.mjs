import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function smokePackage(archive) {
  if (!archive) throw new TypeError('pass a Yandex Function package ZIP path');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'fam-ru-ycf-smoke-'));
  try {
    const packageDir = path.join(temp, 'package');
    await mkdir(packageDir);
    await execFileAsync('unzip', ['-q', path.resolve(archive), '-d', packageDir]);
    await execFileAsync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: packageDir, maxBuffer: 4 * 1024 * 1024,
    });

    const script = String.raw`
      const assert = require('node:assert/strict');
      const http = require('./index.cjs');
      const timer = require('./timer.cjs');
      (async () => {
        const response = await http.handler({ httpMethod: 'GET', path: '/', headers: {}, body: '' }, {});
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
        assert.match(response.body, /FAM/);
        await assert.rejects(timer.handler({ messages: [] }, {}), /invalid timer configuration/);
        console.log('PACKAGED_YCF_ENTRYPOINTS_PASS http=200 timer=fail-closed');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('FAM_RU_')) delete env[key];
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
      cwd: packageDir, env, maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /PACKAGED_YCF_ENTRYPOINTS_PASS http=200 timer=fail-closed/);
    return stdout.trim();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  smokePackage(process.argv[2]).then(result => console.log(result)).catch(error => {
    console.error(`PACKAGED_YCF_ENTRYPOINTS_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}

export { smokePackage };
