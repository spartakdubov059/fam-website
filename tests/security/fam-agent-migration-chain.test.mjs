import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/fam-qwen-qa-failure-migration.yml", import.meta.url), "utf8");
const setup = readFileSync(new URL("../fixtures/fam-qa-failure/qwen-qa-failure-migration-setup.sql", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("../fixtures/fam-qa-failure/lifecycle-chain-assertions.sql", import.meta.url), "utf8");
const fullReplay = readFileSync(new URL("../../.github/workflows/fam-supabase-full-migration-replay.yml", import.meta.url), "utf8");

test("ordered lifecycle migrations coexist and rollback in reverse order", () => {
  const resolver = workflow.indexOf("supabase/migrations/20261126195410_fam_agent_coder_lifecycle_resolution.sql");
  const qaFailure = workflow.indexOf("supabase/migrations/20261126232721_fam_qwen_qa_failed_transition.sql");
  const qaRollback = workflow.indexOf("docs/sql/fam-qwen-qa-failed-transition-rollback.sql");
  const lifecycleRollback = workflow.indexOf("docs/sql/fam-agent-coder-lifecycle-resolution-rollback.sql");
  const lifecycleReapply = workflow.lastIndexOf("supabase/migrations/20261126195410_fam_agent_coder_lifecycle_resolution.sql");
  const qaReapply = workflow.lastIndexOf("supabase/migrations/20261126232721_fam_qwen_qa_failed_transition.sql");

  assert.ok(resolver >= 0 && resolver < qaFailure, "lifecycle resolver must apply before the QA-failure transition");
  assert.ok(qaRollback >= 0 && qaRollback < lifecycleRollback, "rollback must reverse the migration order");
  assert.ok(lifecycleReapply >= 0 && lifecycleReapply < qaReapply, "reapply must restore the original migration order");
  assert.match(workflow, /lifecycle-chain-assertions\.sql/);
  assert.match(workflow, /lifecycle-chain-rollback-assertions\.sql/);
  assert.match(workflow, /lifecycle-chain-reapply-assertions\.sql/);
});

test("synthetic schema contains only the queue fields needed by both RPC migrations", () => {
  assert.match(setup, /payload jsonb not null default '\{\}'::jsonb/);
  assert.match(setup, /created_at timestamptz not null default now\(\)/);
  assert.match(lifecycle, /resolve_fam_agent_coder_lifecycle/);
  assert.match(lifecycle, /postmerge_verified/);
  assert.match(lifecycle, /repeat\('a',40\)/);
});


test("full Supabase replay initializes local config before starting services and resetting migrations", () => {
  const initialize = fullReplay.indexOf("supabase init --workdir \"$GITHUB_WORKSPACE\"");
  const start = fullReplay.indexOf("supabase start");
  const reset = fullReplay.indexOf("supabase db reset");

  assert.ok(initialize >= 0 && initialize < start, "initialize config before local Supabase services start");
  assert.ok(start >= 0 && start < reset, "apply migrations only after local services are ready");
  assert.doesNotMatch(fullReplay, /supabase (?:db reset|start).*--(?:linked|db-url)/);
});
