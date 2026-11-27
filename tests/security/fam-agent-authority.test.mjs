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

test("authority contract names all nine roles and labels policy as non-executing", () => {
  assert.equal(Object.keys(STAFF_AUTHORITY_CONTRACT).length, 9);
  assert.ok(Object.values(STAFF_AUTHORITY_CONTRACT).every((row) =>
    row.enforcement_status === "policy_contract_not_runtime_execution" &&
    row.denied_actions.includes("merge_pr") && row.denied_actions.includes("read_student_data")));
});

test("Boss retry eligibility requires a confirmed, allowlisted, expired and deduplicated task", () => {
  assert.deepEqual(authorizeStaffAction(base), {
    allowed: true, reason: "verified_bounded_retry_candidate", effect: "eligibility_only_no_queue_write",
  });
  for (const change of [
    { evidence: { ...base.evidence, confirmed: false } },
    { evidence: { ...base.evidence, source_verified: false } },
    { evidence: { ...base.evidence, task_key: "arbitrary_sql" } },
    { evidence: { ...base.evidence, lease_expires_at: "2026-11-27T07:05:00Z" } },
    { evidence: { ...base.evidence, attempt_count: 2 } },
    { evidence: { ...base.evidence, duplicate_active: true } },
    { scope: "UNKNOWN" },
    { scope: "FAM_RU" },
    { evidence: { ...base.evidence, source: "worker_queue", event_id: "123e4567-e89b-42d3-a456-426614174000" } },
  ]) assert.equal(authorizeStaffAction({ ...base, ...change }).allowed, false);
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
