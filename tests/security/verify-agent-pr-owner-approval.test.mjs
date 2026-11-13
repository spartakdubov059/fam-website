import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
