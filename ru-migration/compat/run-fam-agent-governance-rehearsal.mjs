import {
  runIsolatedAgentGovernanceRehearsal,
} from './fam-agent-governance-rehearsal.mjs';
import { executeAgentQaEvidence, executeDeveloperPatchEvidence } from './fam-agent-execution-evidence.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const qa = executeAgentQaEvidence({
  cwd,
  testFiles: [
    'ru-migration/compat/fam-agent-team-governance.test.mjs',
    'ru-migration/compat/fam-agent-governance-rehearsal.test.mjs',
  ],
});
const developer = executeDeveloperPatchEvidence({
  cwd,
  approvedScope: [
    'ru-migration/app/backend/server.mjs',
    'ru-migration/app/backend/repositories/ydb-agent-task-queue.mjs',
  ],
});

const rehearsal = runIsolatedAgentGovernanceRehearsal({
  pulls: [
    { number: 167, draft: false, files: [
      'ru-migration/app/backend/server.mjs',
      'ru-migration/app/backend/repositories/ydb-agent-task-queue.mjs',
      'ru-migration/compat/integration-synthetic-inspector.mjs',
    ] },
  ],
  queue: { failed_last_24h: 0, expired_leases: 0 },
  warnings: [],
  developerPatch: developer.ok
    ? {
        approved_scope: developer.approved_scope,
        has_patch: developer.has_patch,
        synthetic_only: true,
        patch_digest: developer.patch_digest,
        production_access: false,
      }
    : { approved_scope: [], has_patch: false, synthetic_only: true, patch_digest: '0'.repeat(64), production_access: false },
  qaResult: qa.ok
    ? { passed: true, tests_run: qa.tests_run, production_access: false, test_digest: qa.test_digest,
        output_sha256: qa.output_sha256, observed_at: qa.observed_at }
    : { passed: false, tests_run: qa.tests_run || 0, production_access: false },
});

if (!rehearsal.ok) {
  console.error(JSON.stringify({ ok: false, code: rehearsal.code, production_access: false }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    code: rehearsal.code,
    stages: rehearsal.stages.map(stage => `${stage.role}:${stage.status}`),
    production_access: false,
    live_cutover_authorized: false,
  }));
}
