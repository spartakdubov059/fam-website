import {
  runIsolatedAgentGovernanceRehearsal,
} from './fam-agent-governance-rehearsal.mjs';
import { executeAgentQaEvidence, executeDeveloperPatchEvidence } from './fam-agent-execution-evidence.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const developer = executeDeveloperPatchEvidence({
  cwd,
  approvedScope: [
    'ru-migration/app/backend/server.mjs',
    'ru-migration/app/backend/repositories/ydb-agent-task-queue.mjs',
  ],
});
const qa = executeAgentQaEvidence({
  cwd,
  patchDigest: developer.ok ? developer.patch_digest : '0'.repeat(64),
  testFiles: [
    'ru-migration/compat/fam-agent-team-governance.test.mjs',
    'ru-migration/compat/fam-agent-governance-rehearsal.test.mjs',
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
  legalConsultation: {
    scope: 'FAM_RU',
    revision_sha256: developer.ok ? developer.revision_sha256 : '0'.repeat(64),
    impact: 'possible',
    classifier: 'arbiter',
    guidance: {
      role: 'legal_advisor', scope: 'FAM_RU',
      revision_sha256: developer.ok ? developer.revision_sha256 : '0'.repeat(64),
      advice_status: 'advisory_only', human_review: 'pending_human_review',
      requirement_codes: ['minimize_data'], alternative_codes: ['synthetic_only', 'defer_live_transfer'],
      source_checks: [{ url: 'https://publication.pravo.gov.ru/', checked_at: new Date().toISOString(), source_digest: '0'.repeat(64) }],
      decision_digest: '0'.repeat(64), synthetic_only: true,
    },
  },
  developerPatch: developer.ok
    ? {
        approved_scope: developer.approved_scope,
        has_patch: developer.has_patch,
        synthetic_only: true,
        patch_digest: developer.patch_digest,
        revision_sha256: developer.revision_sha256,
        production_access: false,
      }
    : { approved_scope: [], has_patch: false, synthetic_only: true, patch_digest: '0'.repeat(64), revision_sha256: '0'.repeat(64), production_access: false },
  qaResult: qa.ok
    ? { passed: true, tests_run: qa.tests_run, production_access: false, test_digest: qa.test_digest,
        output_sha256: qa.output_sha256, observed_at: qa.observed_at,
        revision_sha256: qa.revision_sha256, subject_sha256: qa.subject_sha256,
        patch_digest: qa.patch_digest }
    : {
        passed: false, tests_run: qa.tests_run || 0, production_access: false,
        test_digest: '0'.repeat(64), output_sha256: '0'.repeat(64),
        observed_at: new Date().toISOString(), revision_sha256: '0'.repeat(64),
        subject_sha256: '0'.repeat(64), patch_digest: '0'.repeat(64),
      },
});

if (!developer.ok || !qa.ok || !rehearsal.ok) {
  console.error(JSON.stringify({ ok: false, code: !developer.ok ? developer.code : !qa.ok ? qa.code : rehearsal.code, production_access: false }));
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
