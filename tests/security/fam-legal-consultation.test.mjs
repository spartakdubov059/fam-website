import test from "node:test";
import assert from "node:assert/strict";
import { buildLegalConsultation } from "../../scripts/fam-legal-consultation.mjs";

const REVISION = "a".repeat(40);

test("ordinary FAM_CURRENT changes receive advisory guidance without a migration gate", () => {
  const advice = buildLegalConsultation({ scope: "FAM_CURRENT", revision: REVISION, changedFiles: ["docs/technical-note.md"] });
  assert.equal(advice.status, "no_trigger_detected_not_legal_approval");
  assert.equal(advice.human_review_required, false);
  assert.equal(advice.legal_opinion, false);
  assert.equal(advice.release_authority, false);
  assert.deepEqual(advice.version_scopes, ["FAM_CURRENT"]);
  assert.equal(advice.provisional_priority, "advisory");
  assert.equal(advice.source_verification.status, "not_performed");
  assert.equal(advice.scope_assessments[0].status, "not_assessed");
  assert.equal(advice.scope_assessments[0].readiness_percent, null);
  assert.equal(advice.qwen_guidance.human_decision_required_before_release, false);
});

test("sensitive paths produce category-only evidence and keep the review pending", () => {
  const advice = buildLegalConsultation({
    scope: "FAM_CURRENT", revision: REVISION,
    changedFiles: ["supabase/migrations/adjust_student_policy.sql", "supabase/functions/moderate/index.ts"],
  });
  assert.equal(advice.status, "advisory_review_pending");
  assert.equal(advice.human_review_required, true);
  assert.ok(advice.risk_categories.includes("access_control"));
  assert.ok(advice.risk_categories.includes("student_data_handling"));
  assert.ok(advice.risk_categories.includes("content_moderation"));
  assert.deepEqual(advice.evidence.risk_counts, {
    access_control: 1,
    content_moderation: 1,
    database_change: 1,
    student_data_handling: 1,
  });
  assert.equal(advice.independent_review, "pending_human_review");
  assert.equal(advice.risk_options.every((option) => option.priority === "unassessed" && option.source_status === "not_verified"), true);
  assert.ok(advice.risk_options.find((option) => option.category === "content_moderation")
    .qa_acceptance_check.includes("травли, угроз и запрещённых контактов"));
  assert.ok(advice.qwen_guidance.alternatives.some((option) => option.category === "student_data_handling"));
  assert.doesNotMatch(JSON.stringify(advice), /adjust_student_policy/);
});

test("FAM_RU review stays separate and shared changes get two explicit scopes", () => {
  const ru = buildLegalConsultation({ scope: "FAM_RU", revision: REVISION });
  assert.equal(ru.human_review_required, true);
  assert.deepEqual(ru.version_scopes, ["FAM_RU"]);
  const shared = buildLegalConsultation({ scope: "SHARED", revision: REVISION });
  assert.deepEqual(shared.version_scopes, ["FAM_CURRENT", "FAM_RU"]);
  assert.deepEqual(shared.scope_assessments.map(({ scope, status }) => ({ scope, status })), [
    { scope: "FAM_CURRENT", status: "not_assessed" },
    { scope: "FAM_RU", status: "human_review_pending" },
  ]);
  assert.equal(shared.scope_assessments[1].release_gate, "migration_evidence_pending_for_ru_only");
  assert.ok(shared.qwen_guidance.qa_acceptance_checks.some((item) => item.includes("несвязанные безопасные изменения FAM_CURRENT")));
});

test("missing scope, invalid revision and oversized evidence fail closed", () => {
  assert.throws(() => buildLegalConsultation({ revision: REVISION }), /explicit product scope/);
  assert.throws(() => buildLegalConsultation({ scope: "FAM_CURRENT", revision: "main" }), /exact 40-character revision/);
  assert.throws(() => buildLegalConsultation({ scope: "FAM_CURRENT", revision: REVISION, changedFiles: Array(201).fill("index.html") }), /Invalid changed-file evidence/);
});
