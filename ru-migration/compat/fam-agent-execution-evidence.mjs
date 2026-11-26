import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const ALLOWED_TESTS = new Set([
  'ru-migration/compat/fam-agent-team-governance.test.mjs',
  'ru-migration/compat/fam-agent-governance-rehearsal.test.mjs',
  'ru-migration/compat/synthetic-batch-migration.test.mjs',
  'ru-migration/compat/synthetic-operational-migration.test.mjs',
  'ru-migration/compat/synthetic-operational-envelope.test.mjs',
  'ru-migration/compat/fam-cutover-readiness.test.mjs',
  'ru-migration/compat/fam-route-parity.test.mjs',
]);

export function executeAgentQaEvidence({ cwd, testFiles, nodeExecutable = 'node', now = Date.now } = {}) {
  if (typeof cwd !== 'string' || !Array.isArray(testFiles) || !testFiles.length
      || testFiles.length > 20 || testFiles.some(file => !ALLOWED_TESTS.has(file))) {
    return { ok: false, code: 'INVALID_AGENT_QA_REQUEST', production_access: false };
  }
  const testContents = testFiles.map(file => {
    const path = `${cwd}/${file}`;
    if (!existsSync(path)) return null;
    return readFileSync(path);
  });
  if (testContents.some(content => content === null)) {
    return { ok: false, code: 'MISSING_AGENT_QA_TEST', production_access: false };
  }
  const testDigest = hash(Buffer.concat(testContents));
  const args = ['--test', ...testFiles];
  const result = spawnSync(nodeExecutable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, FAM_RU_NO_PRODUCTION: '1' },
  });
  const passed = result.status === 0 && result.error === undefined;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    ok: passed,
    code: passed ? 'AGENT_QA_EXECUTED_PASS' : 'AGENT_QA_EXECUTED_FAIL',
    passed,
    tests_run: testFiles.length,
    test_digest: testDigest,
    exit_status: Number.isInteger(result.status) ? result.status : null,
    output_sha256: hash(output),
    observed_at: new Date(now()).toISOString(),
    production_access: false,
  };
}

export function executeDeveloperPatchEvidence({ cwd, approvedScope, nodeExecutable = 'node' } = {}) {
  if (typeof cwd !== 'string' || !Array.isArray(approvedScope)
      || !approvedScope.length || approvedScope.length > 20
      || approvedScope.some(path => typeof path !== 'string'
        || (!path.startsWith('ru-migration/') && !path.startsWith('docs/') && !path.startsWith('tests/')))) {
    return { ok: false, code: 'INVALID_DEVELOPER_SCOPE', production_access: false };
  }
  const result = spawnSync('git', ['diff', '--stat', 'HEAD', '--', ...approvedScope], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) return { ok: false, code: 'DEVELOPER_PATCH_EVIDENCE_UNAVAILABLE', production_access: false };
  return {
    ok: true,
    code: 'DEVELOPER_PATCH_EVIDENCE_READY',
    approved_scope: approvedScope,
    synthetic_only: true,
    has_patch: result.stdout.trim().length > 0,
    patch_digest: hash(result.stdout),
    production_access: false,
  };
}
