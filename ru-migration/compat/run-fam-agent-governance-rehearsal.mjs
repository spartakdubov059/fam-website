import {
  runIsolatedAgentGovernanceRehearsal,
} from './fam-agent-governance-rehearsal.mjs';

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
  developerPatch: {
    approved_scope: [
      'ru-migration/app/backend/server.mjs',
      'ru-migration/app/backend/repositories/ydb-agent-task-queue.mjs',
    ],
    has_patch: true,
    synthetic_only: true,
  },
  qaResult: { passed: true, tests_run: 788, production_access: false },
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
