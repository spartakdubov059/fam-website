import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.dirname(ROOT);
const BACKEND = path.join(ROOT, 'app/backend');
const WEB = path.join(ROOT, 'app/web');
const MAX_DIRECT_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(['node_modules', 'test', '.git']);
const EXCLUDED_FILES = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|log))$/i;

async function listTrackedAppFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', 'ru-migration/app/backend', 'ru-migration/app/web'], {
    cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

async function copyTrackedTree(source, target, trackedPaths) {
  for (const repoPath of trackedPaths) {
    const input = path.resolve(REPO_ROOT, repoPath);
    const relative = path.relative(source, input);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
    const segments = relative.split(path.sep);
    const filename = segments.at(-1);
    if (segments.some(segment => EXCLUDED_DIRS.has(segment))
        || filename === 'package.json' || filename === 'package-lock.json' || EXCLUDED_FILES.test(filename)) continue;
    const info = await lstat(input);
    if (info.isSymbolicLink()) throw new Error(`refusing to package symbolic link: ${repoPath}`);
    if (!info.isFile()) continue;
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(input, destination);
  }
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function packageFunction(outputPath) {
  if (!outputPath) throw new TypeError('pass a destination ZIP path; existing files are never overwritten');
  const output = path.resolve(outputPath);
  if (await exists(output)) throw new Error('destination already exists; choose a new path');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'fam-ru-ycf-'));
  const stage = path.join(temp, 'package');
  try {
    await mkdir(path.join(stage, 'app'), { recursive: true });
    const trackedPaths = await listTrackedAppFiles();
    await copyTrackedTree(BACKEND, path.join(stage, 'app/backend'), trackedPaths);
    await copyTrackedTree(WEB, path.join(stage, 'app/web'), trackedPaths);

    const sourcePackage = JSON.parse(await readFile(path.join(BACKEND, 'package.json'), 'utf8'));
    const packageJson = {
      name: 'fam-ru-yandex-function', private: true, type: 'module', engines: sourcePackage.engines,
      dependencies: sourcePackage.dependencies,
    };
    await writeFile(path.join(stage, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', { flag: 'wx' });
    const lock = JSON.parse(await readFile(path.join(BACKEND, 'package-lock.json'), 'utf8'));
    lock.name = packageJson.name;
    lock.packages[''].name = packageJson.name;
    await writeFile(path.join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
    await writeFile(path.join(stage, 'index.cjs'), "'use strict';\nexports.handler = async (event, context) => {\n  void context;\n  const mod = await import('./app/backend/yandex-function.mjs');\n  return mod.handler(event);\n};\n", { flag: 'wx' });
    await writeFile(path.join(stage, 'timer.cjs'), "'use strict';\nexports.handler = async (event, context) => {\n  void context;\n  const mod = await import('./app/backend/yandex-function-timer.mjs');\n  return mod.handler(event);\n};\n", { flag: 'wx' });

    await mkdir(path.dirname(output), { recursive: true });
    await execFileAsync('zip', ['-q', '-r', output, '.'], { cwd: stage, maxBuffer: 1024 * 1024 });
    await execFileAsync('unzip', ['-tq', output], { maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync('unzip', ['-Z1', output], { maxBuffer: 1024 * 1024 });
    const names = stdout.split('\n').filter(Boolean);
    if (names.some(name => /(^|\/)(?:node_modules|test|\.git)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key)$/i.test(name))) {
      throw new Error('archive includes excluded test, dependency, or secret material');
    }
    const bytes = (await stat(output)).size;
    if (bytes > MAX_DIRECT_UPLOAD_BYTES) {
      throw new Error(`archive is ${bytes} bytes; direct upload ceiling is ${MAX_DIRECT_UPLOAD_BYTES} bytes`);
    }
    return { output, bytes, files: names.length, entrypoints: ['index.handler', 'timer.handler'], runtime: 'nodejs22' };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packageFunction(process.argv[2]).then(result => {
    console.log(`YCF_PACKAGE_READY ${JSON.stringify(result)}`);
    console.log('Dependencies are pinned by the included package-lock.json; cloud resources were not created.');
  }).catch(error => {
    console.error(`YCF_PACKAGE_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}

export { packageFunction };
