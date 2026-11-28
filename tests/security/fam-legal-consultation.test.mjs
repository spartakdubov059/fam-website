import test from "node:test";
import assert from "node:assert/strict";
import { buildLegalConsultation } from "../../scripts/fam-legal-consultation.mjs";

const REVISION = "a".repeat(40);
const BRANCH = "codex/legal-synthetic-test";
const consult = (input) => buildLegalConsultation({ branch: BRANCH, ...input });

test("ordinary FAM_CURRENT changes receive advisory guidance without a migration gate", () => {
  const advice = consult({ scope: "FAM_CURRENT", revision: REVISION, changedFiles: ["docs/technical-note.md"] });
  assert.equal(advice.branch, BRANCH);
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
  const advice = consult({
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
  const ru = consult({ scope: "FAM_RU", revision: REVISION });
  assert.equal(ru.human_review_required, true);
  assert.deepEqual(ru.version_scopes, ["FAM_RU"]);
  const shared = consult({ scope: "SHARED", revision: REVISION });
  assert.deepEqual(shared.version_scopes, ["FAM_CURRENT", "FAM_RU"]);
  assert.deepEqual(shared.scope_assessments.map(({ scope, status }) => ({ scope, status })), [
    { scope: "FAM_CURRENT", status: "not_assessed" },
    { scope: "FAM_RU", status: "human_review_pending" },
  ]);
  assert.equal(shared.scope_assessments[1].release_gate, "migration_evidence_pending_for_ru_only");
  assert.ok(shared.qwen_guidance.qa_acceptance_checks.some((item) => item.includes("несвязанные безопасные изменения FAM_CURRENT")));
});

test("the bridge gets advisory risk topics from the allowlisted task scope", () => {
  const advice = consult({
    scope: "FAM_CURRENT",
    revision: REVISION,
    taskKey: "audit_agent_infrastructure",
  });
  assert.deepEqual(advice.risk_categories, ["access_control", "external_processing"]);
  assert.equal(advice.evidence.changed_file_count, 0);
  assert.equal(advice.evidence.signal_source, "allowlisted_task_scope_and_declared_paths");
  assert.equal(advice.status, "advisory_review_pending");
  assert.equal(advice.legal_opinion, false);
  assert.equal(advice.release_authority, false);
  assert.throws(() => consult({
    scope: "FAM_CURRENT",
    revision: REVISION,
    taskKey: "untrusted_task",
  }), /allowlisted task key/);
});

test("missing scope, invalid revision and oversized evidence fail closed", () => {
  assert.throws(() => consult({ revision: REVISION }), /explicit product scope/);
  assert.throws(() => consult({ scope: "FAM_CURRENT", revision: "main" }), /exact 40-character revision/);
  assert.throws(() => consult({ scope: "FAM_CURRENT", revision: REVISION, changedFiles: Array(201).fill("index.html") }), /Invalid changed-file evidence/);
});

test("branch and exact revision must be supplied as a safe pair of scope metadata", () => {
  assert.throws(() => buildLegalConsultation({ scope: "FAM_CURRENT", revision: REVISION }), /exact safe branch ref/);
  for (const branch of ["", "../main", "main..pr", "main//test", "main@{1}", "main.lock", "main?x"]) {
    assert.throws(() => buildLegalConsultation({ scope: "FAM_CURRENT", branch, revision: REVISION }), /exact safe branch ref/);
  }
  const result = consult({ scope: "FAM_CURRENT", revision: REVISION });
  assert.equal(result.branch, BRANCH);
  assert.equal(result.revision, REVISION);
});

test("planned feature assessment uses fixed synthetic risk flags and stays non-authoritative", () => {
  const plannedFeature = {
    featureKey: "media_upload",
    riskFlags: {
      handles_student_data: true,
      uses_private_media: true,
      adds_external_provider: false,
      changes_access_control: true,
      changes_moderation: false,
      adds_persistent_storage: true,
    },
  };
  const result = consult({
    scope: "FAM_CURRENT",
    revision: REVISION,
    plannedFeature,
  });
  const assessment = result.planned_feature_assessment;
  assert.equal(assessment.status, "preliminary_technical_risk_screen_only");
  assert.deepEqual(assessment.risk_categories, [
    "access_control",
    "database_change",
    "file_and_media_handling",
    "student_data_handling",
  ]);
  assert.deepEqual(assessment.scope_assessments.map((item) => item.scope), ["FAM_CURRENT"]);
  assert.equal(assessment.scope_assessments[0].status, "human_review_pending");
  assert.equal(assessment.legal_opinion, false);
  assert.equal(assessment.release_authority, false);
  assert.equal(assessment.independent_human_review, "pending_human_review");
  assert.equal(assessment.source_verification, "not_performed");
  assert.equal(assessment.qa_acceptance_checks.length, 4);
  assert.equal(result.qwen_guidance.planned_feature_assessment, assessment);
});

test("shared planned-feature review keeps FAM_CURRENT and FAM_RU separate", () => {
  const result = consult({
    scope: "SHARED",
    revision: REVISION,
    plannedFeature: {
      featureKey: "custom_feature",
      riskFlags: {
        handles_student_data: false,
        uses_private_media: false,
        adds_external_provider: false,
        changes_access_control: false,
        changes_moderation: false,
        adds_persistent_storage: false,
      },
    },
  });
  assert.deepEqual(result.planned_feature_assessment.scope_assessments.map((item) => item.scope), [
    "FAM_CURRENT",
    "FAM_RU",
  ]);
  assert.deepEqual(result.planned_feature_assessment.risk_categories, []);
  assert.equal(result.planned_feature_assessment.release_authority, false);
  assert.equal(result.qwen_guidance.human_decision_required_before_release, true);
});

test("planned-feature assessment rejects free text, unknown flags, and missing risk declarations", () => {
  const riskFlags = {
    handles_student_data: false,
    uses_private_media: false,
    adds_external_provider: false,
    changes_access_control: false,
    changes_moderation: false,
    adds_persistent_storage: false,
  };
  for (const plannedFeature of [
    { featureKey: "untrusted", riskFlags },
    { featureKey: "custom_feature", riskFlags, description: "free text is not accepted" },
    { featureKey: "custom_feature", riskFlags: { ...riskFlags, unknown: true } },
    { featureKey: "custom_feature", riskFlags: { ...riskFlags, handles_student_data: "unknown" } },
    { featureKey: "custom_feature", riskFlags: { handles_student_data: false } },
  ]) {
    assert.throws(() => consult({
      scope: "FAM_CURRENT",
      revision: REVISION,
      plannedFeature,
    }), /Planned feature/);
  }
});
