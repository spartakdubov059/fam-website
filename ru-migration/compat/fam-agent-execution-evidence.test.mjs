import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAgentQaEvidence, executeDeveloperPatchEvidence } from './fam-agent-execution-evidence.mjs';

test('QA evidence executes a real allowlisted node test and returns hashes', () => {
  const cwd = new URL('../..', import.meta.url).pathname;
  const result = executeAgentQaEvidence({
    cwd,
    testFiles: ['ru-migration/compat/fam-agent-team-governance.test.mjs'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
  assert.equal(result.production_access, false);
  assert.match(result.test_digest, /^[a-f0-9]{64}$/);
  assert.match(result.output_sha256, /^[a-f0-9]{64}$/);
});

test('QA evidence rejects unknown test files and developer evidence rejects protected scope', () => {
  const cwd = new URL('../..', import.meta.url).pathname;
  assert.equal(executeAgentQaEvidence({
    cwd,
    testFiles: ['supabase/functions/moderate/index.ts'],
  }).code, 'INVALID_AGENT_QA_REQUEST');
  assert.equal(executeDeveloperPatchEvidence({
    cwd,
    approvedScope: ['supabase/functions/moderate/index.ts'],
  }).code, 'INVALID_DEVELOPER_SCOPE');
});


test('agent execution refuses arbitrary binaries, duplicate tests and traversal scopes',()=>{
 const cwd=new URL('../..',import.meta.url).pathname;
 const file='ru-migration/compat/fam-agent-team-governance.test.mjs';
 assert.equal(executeAgentQaEvidence({cwd,testFiles:[file],nodeExecutable:'not-approved'}).code,'INVALID_AGENT_QA_REQUEST');
 assert.equal(executeAgentQaEvidence({cwd,testFiles:[file,file]}).code,'INVALID_AGENT_QA_REQUEST');
 for(const path of ['ru-migration/../supabase/functions/moderate/index.ts','ru-migration/**','ru-migration//compat/file.mjs','ru-migration/./compat/file.mjs'])assert.equal(executeDeveloperPatchEvidence({cwd,approvedScope:[path]}).code,'INVALID_DEVELOPER_SCOPE');
});
