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

export function executeAgentQaEvidence({ cwd, testFiles, patchDigest = '0'.repeat(64), nodeExecutable = 'node', now = Date.now } = {}) {
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
  if (!/^[a-f0-9]{64}$/.test(patchDigest)) {
    return { ok: false, code: 'INVALID_AGENT_QA_PATCH_DIGEST', production_access: false };
  }
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 30_000 });
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    return { ok: false, code: 'AGENT_QA_REVISION_UNAVAILABLE', production_access: false };
  }
  const beforeResult = spawnSync('git', ['diff', '--binary', 'HEAD', '--', ...testFiles], { cwd, encoding: 'utf8', timeout: 30_000 });
  const beforeDiff = beforeResult.status === 0 ? beforeResult.stdout : '';
  const beforeDigest = hash(beforeDiff);
  const args = ['--test', ...testFiles];
  const result = spawnSync(nodeExecutable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, FAM_RU_NO_PRODUCTION: '1' },
  });
  const passed = result.status === 0 && result.error === undefined;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const afterResult = spawnSync('git', ['diff', '--binary', 'HEAD', '--', ...testFiles], { cwd, encoding: 'utf8', timeout: 30_000 });
  const afterDiff = afterResult.status === 0 ? afterResult.stdout : '';
  if (hash(afterDiff) !== beforeDigest) {
    return { ok: false, code: 'AGENT_QA_WORKTREE_CHANGED', production_access: false };
  }
  const subjectSha = hash(JSON.stringify({ revision: headSha, test_digest: testDigest, patch_digest: patchDigest, test_patch_digest: beforeDigest }));
  return {
    ok: passed,
    code: passed ? 'AGENT_QA_EXECUTED_PASS' : 'AGENT_QA_EXECUTED_FAIL',
    passed,
    tests_run: testFiles.length,
    test_digest: testDigest,
    exit_status: Number.isInteger(result.status) ? result.status : null,
    output_sha256: hash(output),
    observed_at: new Date(now()).toISOString(),
    revision_sha256: hash(headSha),
    subject_sha256: subjectSha,
    patch_digest: patchDigest,
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
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 30_000 });
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    return { ok: false, code: 'DEVELOPER_PATCH_REVISION_UNAVAILABLE', production_access: false };
  }
  const result = spawnSync('git', ['diff', '--binary', 'HEAD', '--', ...approvedScope], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) return { ok: false, code: 'DEVELOPER_PATCH_EVIDENCE_UNAVAILABLE', production_access: false };
  const patchSha = hash(result.stdout);
  return {
    ok: true,
    code: 'DEVELOPER_PATCH_EVIDENCE_READY',
    approved_scope: approvedScope,
    synthetic_only: true,
    has_patch: result.stdout.trim().length > 0,
    patch_digest: patchSha,
    revision_sha256: hash(headSha),
    production_access: false,
  };
}
