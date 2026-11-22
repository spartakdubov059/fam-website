import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL(
  "../../supabase/migrations/20261122100000_fam_qwen_lease_and_lifecycle.sql",
  import.meta.url,
), "utf8");
const workflow = readFileSync(new URL(
  "../../.github/workflows/fam-codex-developer.yml",
  import.meta.url,
), "utf8");

test("lease heartbeat is short, owner-bound, and cannot revive expired leases", () => {
  assert.match(migration, /least\(greatest\(coalesce\(p_lease_seconds,1800\),300\),1800\)/);
  assert.match(migration, /t\.claimed_by = p_worker_id/);
  assert.match(migration, /t\.lease_expires_at > pg_catalog\.now\(\)/);
  assert.match(workflow, /while sleep 900; do node scripts\/fam-agent-bridge\.mjs heartbeat/);
});

test("model generation and QA do not mark an issue with a patch completed", () => {
  assert.match(migration, /when 'model_generated' then[\s\S]*?v_summary := 'Модель подготовила предложение/);
  assert.match(migration, /when 'qa_passed' then[\s\S]*?v_summary := 'Независимая QA прошла/);
  assert.match(migration, /when 'pr_created' then[\s\S]*?v_summary := 'PR создан после независимой QA/);
  const modelStage = migration.match(/when 'model_generated' then([\s\S]*?)(?=when 'qa_passed')/)?.[1] ?? "";
  const qaStage = migration.match(/when 'qa_passed' then([\s\S]*?)(?=when 'pr_created')/)?.[1] ?? "";
  const prStage = migration.match(/when 'pr_created' then([\s\S]*?)(?=when 'qa_failed')/)?.[1] ?? "";
  assert.ok(modelStage && qaStage && prStage);
  assert.doesNotMatch(modelStage + qaStage + prStage, /v_status := 'completed'/);
});

test("Qwen's bridge cannot claim owner approval, merge, or post-merge verification", () => {
  assert.doesNotMatch(migration, /when '(owner_approved|merged|postmerge_verified)'/);
  assert.doesNotMatch(workflow, /gh pr merge|git push origin main/);
  assert.match(workflow, /решения владельца/);
});

test("scheduled runs without a queued task skip model download and build", () => {
  assert.ok(workflow.indexOf("Получить одно безопасное задание") < workflow.indexOf("Скачать бесплатную модель"));
  assert.match(workflow, /steps\.coder-queue\.outputs\.claimed/);
  assert.match(workflow, /Разрешённой задачи нет; загрузка модели и сборка пропущены/);
  assert.match(workflow, /steps\.preflight\.outputs\.schedule_enabled == 'true'/);
});
