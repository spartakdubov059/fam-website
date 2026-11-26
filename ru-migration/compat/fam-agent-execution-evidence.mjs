import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
// Trusted checkout only, in isolated CI. Environment filtering is not network isolation.
const isolatedEnv = () => Object.fromEntries(Object.entries({
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  SystemRoot: process.env.SystemRoot, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', FAM_RU_NO_PRODUCTION: '1',
}).filter(([,v])=>typeof v==='string'));
export function isSafeRehearsalScope(path) {
  return typeof path==='string'&&path.length<=240
    && /^(?:ru-migration|docs|tests)\/[a-zA-Z0-9_.\/-]+$/.test(path)
    && path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
}
function git(cwd,args) {
  return spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,env:isolatedEnv(),maxBuffer:4*1024*1024});
}
function worktree(cwd) {
  const result=git(cwd,['status','--porcelain=v1','--untracked-files=all']);
  return result.status===0&&!result.error?result.stdout:null;
}
const ALLOWED_TESTS = new Set([
  'ru-migration/compat/fam-agent-team-governance.test.mjs',
  'ru-migration/compat/fam-agent-governance-rehearsal.test.mjs',
  'ru-migration/compat/synthetic-batch-migration.test.mjs',
  'ru-migration/compat/synthetic-operational-migration.test.mjs',
  'ru-migration/compat/synthetic-operational-envelope.test.mjs',
  'ru-migration/compat/fam-cutover-readiness.test.mjs',
  'ru-migration/compat/fam-route-parity.test.mjs',
]);

export function executeAgentQaEvidence({ cwd, testFiles, patchDigest = '0'.repeat(64), nodeExecutable = process.execPath, now = Date.now } = {}) {
  if (typeof cwd !== 'string' || !Array.isArray(testFiles) || !testFiles.length
      || testFiles.length > 20 || new Set(testFiles).size!==testFiles.length || testFiles.some(file => !ALLOWED_TESTS.has(file)) || nodeExecutable!==process.execPath) {
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
  const testDigest = hash(JSON.stringify(testFiles.map((file,index)=>[file,hash(testContents[index])])));
  if (!/^[a-f0-9]{64}$/.test(patchDigest)) {
    return { ok: false, code: 'INVALID_AGENT_QA_PATCH_DIGEST', production_access: false };
  }
  const headResult = git(cwd,['rev-parse','HEAD']);
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    return { ok: false, code: 'AGENT_QA_REVISION_UNAVAILABLE', production_access: false };
  }
  const beforeStatus=worktree(cwd);
  const beforeResult=git(cwd,['diff','--no-ext-diff','--no-textconv','--binary','HEAD','--','.']);
  if(beforeStatus===null||beforeResult.status!==0||beforeResult.error) return {ok:false,code:'AGENT_QA_WORKTREE_UNAVAILABLE',production_access:false};
  const beforeDigest=hash(beforeResult.stdout);
  const args = ['--test', ...testFiles];
  const result = spawnSync(nodeExecutable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: isolatedEnv(),
    maxBuffer: 4*1024*1024,
  });
  const passed = result.status === 0 && result.error === undefined;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const afterResult=git(cwd,['diff','--no-ext-diff','--no-textconv','--binary','HEAD','--','.']);
  const afterHead=git(cwd,['rev-parse','HEAD']);
  if (afterResult.status!==0||afterResult.error||afterHead.status!==0||afterHead.stdout.trim()!==headSha||worktree(cwd)!==beforeStatus||hash(afterResult.stdout)!==beforeDigest) {
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

export function executeDeveloperPatchEvidence({ cwd, approvedScope, nodeExecutable = process.execPath } = {}) {
  if (typeof cwd !== 'string' || !Array.isArray(approvedScope)
      || !approvedScope.length || approvedScope.length > 20
      || new Set(approvedScope).size!==approvedScope.length
      || approvedScope.some(path=>!isSafeRehearsalScope(path)) || nodeExecutable!==process.execPath) {
    return { ok: false, code: 'INVALID_DEVELOPER_SCOPE', production_access: false };
  }
  const headResult = git(cwd,['rev-parse','HEAD']);
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    return { ok: false, code: 'DEVELOPER_PATCH_REVISION_UNAVAILABLE', production_access: false };
  }
  const result=git(cwd,['--literal-pathspecs','diff','--no-ext-diff','--no-textconv','--binary','HEAD','--',...approvedScope]);
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
