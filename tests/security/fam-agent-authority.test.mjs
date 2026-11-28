import test from "node:test";
import assert from "node:assert/strict";
import { authorizeStaffAction, STAFF_AUTHORITY_CONTRACT } from "../../scripts/fam-agent-authority.mjs";

const base = {
  role: "arbiter",
  action: "propose_reassign",
  scope: "FAM_CURRENT",
  now: Date.parse("2026-11-27T07:00:00Z"),
  evidence: {
    confirmed: true,
    source_verified: true,
    source: "github_actions",
    kind: "workflow_failure",
    run_id: 45186664053,
    task_key: "audit_accessibility",
    lease_expires_at: "2026-11-27T06:30:00Z",
    attempt_count: 0,
    max_attempts: 2,
    duplicate_active: false,
  },
};
const trustedEvidence = Object.freeze({
  source: "github_actions",
  kind: "workflow_failure",
  run_id: 45186664053,
  event_id: null,
  task_key: "audit_accessibility",
  lease_expires_at: "2026-11-27T06:30:00Z",
  attempt_count: 0,
  max_attempts: 2,
  duplicate_active: false,
});
const verifyEvidence = (evidence) => Object.entries(trustedEvidence)
  .every(([key, value]) => evidence[key] === value);

test("authority contract names all nine roles and labels policy as non-executing", () => {
  assert.equal(Object.keys(STAFF_AUTHORITY_CONTRACT).length, 9);
  assert.ok(Object.values(STAFF_AUTHORITY_CONTRACT).every((row) =>
    row.enforcement_status === "policy_contract_not_runtime_execution" &&
    row.denied_actions.includes("merge_pr") && row.denied_actions.includes("read_student_data")));
});

test("Boss retry eligibility requires a confirmed, allowlisted, expired and deduplicated task", () => {
  assert.deepEqual(authorizeStaffAction({ ...base, verifyEvidence }), {
    allowed: true, reason: "verified_bounded_retry_candidate", effect: "eligibility_only_no_queue_write",
  });
  for (const change of [
    { evidence: { ...base.evidence, task_key: "arbitrary_sql" } },
    { evidence: { ...base.evidence, lease_expires_at: "2026-11-27T07:05:00Z" } },
    { evidence: { ...base.evidence, attempt_count: 2 } },
    { evidence: { ...base.evidence, duplicate_active: true } },
    { scope: "UNKNOWN" },
    { scope: "FAM_RU" },
    { evidence: { ...base.evidence, source: "worker_queue", event_id: "123e4567-e89b-42d3-a456-426614174000" } },
  ]) assert.equal(authorizeStaffAction({ ...base, verifyEvidence, ...change }).allowed, false);
  assert.equal(authorizeStaffAction({
    ...base, verifyEvidence,
    evidence: { ...base.evidence, confirmed: false, source_verified: false },
  }).allowed, true, "caller-controlled booleans do not override independently verified source evidence");
  assert.equal(authorizeStaffAction(base).reason, "trusted_evidence_verifier_required");
  assert.equal(authorizeStaffAction({ ...base, verifyEvidence: () => false }).reason, "source_evidence_not_verified");
  assert.equal(authorizeStaffAction({ ...base, verifyEvidence: () => { throw new Error("offline"); } }).reason,
    "source_evidence_not_verified");
  assert.equal(authorizeStaffAction({ ...base, verifyEvidence: () => Promise.resolve(true) }).reason,
    "source_evidence_not_verified");
  for (const evidenceChange of [
    { run_id: 45186664054 },
    { task_key: "audit_client_resilience" },
    { lease_expires_at: "2026-11-27T06:00:00Z" },
    { attempt_count: 1 },
    { max_attempts: 1 },
  ]) {
    assert.equal(authorizeStaffAction({
      ...base, verifyEvidence, evidence: { ...base.evidence, ...evidenceChange },
    }).reason, "source_evidence_not_verified", "all retry facts must match the source record");
  }
  let verifierCalls = 0;
  assert.equal(authorizeStaffAction({
    ...base, scope: "FAM_RU", verifyEvidence: () => { verifierCalls++; return true; },
  }).reason, "task_scope_not_enabled_for_reassignment");
  assert.equal(verifierCalls, 0, "reject ineligible work before invoking external evidence verification");
  assert.equal(authorizeStaffAction({
    ...base, evidence: { ...base.evidence, confirmed: true, source_verified: true },
  }).reason, "trusted_evidence_verifier_required", "caller-supplied booleans cannot authenticate evidence");
  let verificationInput;
  const sanitized = authorizeStaffAction({
    ...base,
    evidence: { ...base.evidence, private_payload: "synthetic-only-marker" },
    verifyEvidence: (input) => { verificationInput = input; return verifyEvidence(input); },
  });
  assert.equal(sanitized.allowed, true);
  assert.deepEqual(Object.keys(verificationInput).sort(), [
    "attempt_count", "duplicate_active", "event_id", "kind", "lease_expires_at",
    "max_attempts", "run_id", "source", "task_key",
  ]);
  assert.equal("private_payload" in verificationInput, false);
});

test("each declared capability is role-specific and inspectable but policy remains non-executing", () => {
  for (const [role, authority] of Object.entries(STAFF_AUTHORITY_CONTRACT)) {
    for (const action of authority.allowed_actions.filter((item) => item !== "propose_reassign")) {
      assert.equal(authorizeStaffAction({ role, action, scope: "FAM_CURRENT" }).allowed, true, `${role}:${action}`);
    }
  }
  assert.equal(STAFF_AUTHORITY_CONTRACT.arbiter.enforcement_status, "policy_contract_not_runtime_execution");
});

test("no staff role can self-approve, merge, deploy, widen access, or read private student data", () => {
  for (const role of Object.keys(STAFF_AUTHORITY_CONTRACT)) {
    for (const action of ["approve_own_change", "merge_pr", "deploy_production", "change_auth_or_roles", "read_student_data", "read_private_messages"]) {
      assert.equal(authorizeStaffAction({ role, action, scope: "FAM_CURRENT" }).allowed, false, `${role}:${action}`);
    }
  }
  assert.equal(authorizeStaffAction({ role: "unknown", action: "propose_feature", scope: "FAM_CURRENT" }).allowed, false);
});
