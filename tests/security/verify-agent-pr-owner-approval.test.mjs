import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hasCurrentOwnerApproval } from "../../scripts/verify-agent-pr-owner-approval.mjs";
import { isAllowedAgentPath } from "../../scripts/validate-local-agent-patch.mjs";

const workflow = readFileSync(
  new URL("../../.github/workflows/moderation-regression.yml", import.meta.url),
  "utf8",
);
const head = "c6c50f9e7a8d1f6619d2feee73a5105ecf64cb52";
const baseReview = {
  id: 12,
  user: { login: "spartakdubov059" },
  state: "APPROVED",
  commit_id: head,
  submitted_at: "2026-11-13T10:00:00Z",
};

function jobSource(id) {
  return workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0] ?? "";
}

test("owner approval gate is wired into the required safety check for automated PRs", () => {
  assert.match(workflow, /pull_request_review:\s*\n\s*types:\s*\[submitted, edited, dismissed\]/);
  assert.match(workflow, /name: Russian content safety tests/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /Checkout trusted approval verifier from the base commit/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /if: github\.event\.pull_request\.base\.ref == 'main' && startsWith\(github\.event\.pull_request\.head\.ref, 'codex\/fam-run-'\)/);
  assert.match(workflow, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /node "\$TRUSTED_BASE_DIR\/scripts\/verify-agent-pr-owner-approval\.mjs"/);
});

test("automated patches cannot change the owner gate or its trusted verifier", () => {
  for (const path of [
    ".github/workflows/moderation-regression.yml",
    "scripts/verify-agent-pr-owner-approval.mjs",
  ]) {
    assert.equal(isAllowedAgentPath(path), false, path);
  }
});

test("owner approval executes on a separate runner with no PR-controlled code or artifacts", () => {
  const regression = jobSource("moderation-tests");
  const approval = jobSource("owner-approval");
  assert.match(regression, /node --test tests\/moderation/);
  assert.doesNotMatch(regression, /verify-agent-pr-owner-approval|GITHUB_TOKEN|pull-requests: read/);
  assert.match(approval, /runs-on: ubuntu-latest/);
  assert.match(approval, /node-version: 22/);
  assert.equal((approval.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.match(approval, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(approval, /persist-credentials: false/);
  assert.doesNotMatch(approval, /download-artifact|node --test|git apply|pull_request\.head\.sha[^\n]*ref/);
  const commands = [...approval.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, ['node "$TRUSTED_BASE_DIR/scripts/verify-agent-pr-owner-approval.mjs"']);
  // A skipped gate job must never become an implicit successful required check.
  assert.doesNotMatch(approval.split("    steps:")[0], /\n    if:/);
});

test("required check fails closed for unsuccessful, skipped, cancelled, or missing dependency results", () => {
  const required = jobSource("required-safety-check");
  assert.match(required, /name: Russian content safety tests/);
  assert.match(required, /needs: \[moderation-tests, owner-approval\]/);
  assert.match(required, /if: always\(\)/);
  assert.match(required, /permissions: \{\}/);
  assert.match(required, /REGRESSION_RESULT: \$\{\{ needs\.moderation-tests\.result \}\}/);
  assert.match(required, /APPROVAL_RESULT: \$\{\{ needs\.owner-approval\.result \}\}/);
  assert.doesNotMatch(required, /checkout@|download-artifact|GITHUB_TOKEN|continue-on-error/);
  assert.equal((workflow.match(/name: Russian content safety tests/g) ?? []).length, 1);
  const script = required.split("        run: |\n")[1]?.replace(/^          /gm, "");
  assert.ok(script, "required check must execute its result validation");
  const results = ["success", "failure", "cancelled", "skipped", ""];
  for (const regression of results) {
    for (const approval of results) {
      const execution = spawnSync("bash", ["-e", "-c", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, REGRESSION_RESULT: regression, APPROVAL_RESULT: approval },
      });
      assert.equal(execution.status, regression === "success" && approval === "success" ? 0 : 1,
        `regression=${regression}, approval=${approval}: ${execution.stderr}`);
    }
  }
});

test("accepts owner approval for current head", () => {
  assert.equal(hasCurrentOwnerApproval([baseReview], head), true);
});

test("rejects approval for an older commit", () => {
  assert.equal(hasCurrentOwnerApproval([{ ...baseReview, commit_id: "a".repeat(40) }], head), false);
});

test("rejects another reviewer's approval", () => {
  assert.equal(hasCurrentOwnerApproval([{ ...baseReview, user: { login: "someone-else" } }], head), false);
});

test("latest owner review controls approval state", () => {
  const laterComment = {
    ...baseReview,
    id: 13,
    state: "COMMENTED",
    submitted_at: "2026-11-13T10:05:00Z",
  };
  assert.equal(hasCurrentOwnerApproval([baseReview, laterComment], head), false);
});

test("latest owner approval after changes requested restores the gate", () => {
  const earlierChanges = {
    ...baseReview,
    id: 11,
    state: "CHANGES_REQUESTED",
    submitted_at: "2026-11-13T09:00:00Z",
  };
  assert.equal(hasCurrentOwnerApproval([baseReview, earlierChanges], head), true);
});

test("fails closed on malformed or missing data", () => {
  assert.equal(hasCurrentOwnerApproval(null, head), false);
  assert.equal(hasCurrentOwnerApproval([baseReview], "not-a-sha"), false);
});
