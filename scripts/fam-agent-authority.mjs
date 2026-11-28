// Executable policy contract for the nine approved FAM staff roles.
// This decides eligibility only; it does not perform writes, grant new tokens,
// merge pull requests, deploy code, or read user records.
const ROLES = Object.freeze({
  arbiter: ["monitor_deadlines", "propose_reassign", "resolve_task_conflict"],
  inspector: ["check_regression", "assess_aggregate_efficiency", "enqueue_allowlisted_signal"],
  legal: ["provide_scoped_advisory", "escalate_legal_risk"],
  qwen: ["propose_code_change", "propose_product_improvement"],
  qa: ["add_synthetic_test", "reject_unverified_patch"],
  integrator: ["reconcile_pr", "propose_integration_order", "record_verified_lifecycle"],
  recruiter: ["assess_team_aggregate", "recommend_role_or_technology_change"],
  moderator: ["assess_moderation_aggregate", "recommend_moderation_improvement"],
  development_advisor: ["assess_product_aggregate", "propose_feature", "propose_ux_improvement"],
});

const SCOPES = new Set(["FAM_CURRENT", "FAM_RU", "SHARED"]);
const TASK_KEYS = new Set([
  "audit_frontend_runtime", "audit_client_resilience", "audit_accessibility", "audit_agent_infrastructure",
]);
const FAILURE_SOURCES = new Set(["github_actions", "worker_queue", "cron"]);
const FAILURE_KINDS = new Set(["workflow_failure", "worker_failure", "expired_lease", "cron_failure"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALWAYS_DENIED = new Set([
  "approve_own_change", "merge_pr", "deploy_production", "change_auth_or_roles",
  "grant_credentials", "read_student_data", "read_private_messages", "apply_legal_decision",
  "impose_user_sanction", "change_billing",
]);

export const STAFF_AUTHORITY_CONTRACT = Object.freeze(Object.fromEntries(
  Object.entries(ROLES).map(([role, actions]) => [role, Object.freeze({
    allowed_actions: Object.freeze([...actions]),
    denied_actions: Object.freeze([...ALWAYS_DENIED]),
    enforcement_status: "policy_contract_not_runtime_execution",
  })]),
));

const deny = (reason) => Object.freeze({ allowed: false, reason, effect: "none" });

export function authorizeStaffAction({ role, action, scope, evidence, verifyEvidence, now = Date.now() } = {}) {
  const capabilities = ROLES[role];
  if (!capabilities || typeof action !== "string") return deny("unknown_role_or_action");
  if (ALWAYS_DENIED.has(action) || !capabilities.includes(action)) return deny("outside_role_authority");
  if (!SCOPES.has(scope)) return deny("explicit_scope_required");

  if (action !== "propose_reassign") {
    return Object.freeze({ allowed: true, reason: "allowlisted_role_action", effect: "bounded_role_action" });
  }

  const sourceEvidenceValid = evidence?.source === "github_actions"
    ? evidence.kind === "workflow_failure" && Number.isSafeInteger(evidence.run_id) && evidence.run_id > 0
    : evidence?.source === "worker_queue"
      ? ["worker_failure", "expired_lease"].includes(evidence.kind) && UUID.test(evidence.event_id || "")
      : evidence?.source === "cron"
        ? evidence.kind === "cron_failure" && Number.isSafeInteger(evidence.run_id) && evidence.run_id > 0
        : false;
  if (!evidence || !FAILURE_SOURCES.has(evidence.source) || !FAILURE_KINDS.has(evidence.kind) || !sourceEvidenceValid) {
    return deny("confirmed_failure_evidence_required");
  }
  // Boolean claims in the evidence payload are caller-controlled. The caller
  // must supply a trusted source verifier; never treat `confirmed: true` or
  // `source_verified: true` as proof by themselves. Pass only the bounded
  // evidence fields that the verifier needs, never arbitrary caller fields.
  if (typeof verifyEvidence !== "function") return deny("trusted_evidence_verifier_required");
  const verificationInput = Object.freeze({
    source: evidence.source,
    kind: evidence.kind,
    run_id: evidence.run_id ?? null,
    event_id: evidence.event_id ?? null,
    task_key: evidence.task_key,
    lease_expires_at: evidence.lease_expires_at,
    attempt_count: evidence.attempt_count,
    max_attempts: evidence.max_attempts,
    duplicate_active: evidence.duplicate_active,
  });
  let evidenceVerified = false;
  try { evidenceVerified = verifyEvidence(verificationInput) === true; } catch { /* fail closed */ }
  if (!evidenceVerified) return deny("source_evidence_not_verified");
  if (scope !== "FAM_CURRENT") return deny("task_scope_not_enabled_for_reassignment");
  if (!TASK_KEYS.has(evidence.task_key)) return deny("task_type_not_allowlisted");
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(evidence.lease_expires_at || "")) ||
      Date.parse(evidence.lease_expires_at) > now) return deny("active_or_unverified_lease");
  if (!Number.isSafeInteger(evidence.attempt_count) || !Number.isSafeInteger(evidence.max_attempts) ||
      evidence.attempt_count < 0 || evidence.max_attempts < 1 || evidence.max_attempts > 2 ||
      evidence.attempt_count >= evidence.max_attempts) return deny("retry_budget_exhausted_or_invalid");
  if (evidence.duplicate_active !== false) return deny("duplicate_status_not_proven_clear");

  return Object.freeze({
    allowed: true,
    reason: "verified_bounded_retry_candidate",
    effect: "eligibility_only_no_queue_write",
  });
}
