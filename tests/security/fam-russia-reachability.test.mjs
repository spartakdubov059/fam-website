import test from "node:test";
import assert from "node:assert/strict";
import { NODES, TARGETS, summarizeNodeResult } from "../../scripts/check-fam-russia-reachability.mjs";

test("public diagnostic uses bounded approved endpoints and Russian + EU controls", () => {
  assert.equal(NODES.length, 4);
  assert.ok(NODES.includes("ru1.node.check-host.net"));
  assert.ok(NODES.includes("ru2.node.check-host.net"));
  assert.ok(NODES.includes("ru3.node.check-host.net"));
  assert.ok(NODES.includes("de1.node.check-host.net"));
  assert.equal(TARGETS.length, 5);
  assert.ok(TARGETS.some(t => t.name === "FAM redirect health marker"));
  assert.ok(TARGETS.every(t => t.url.startsWith("https://")));
});

test("check-host HTTP success and redirects are interpreted separately", () => {
  assert.equal(summarizeNodeResult([[1, 0.15, "OK", "200"]]).state, "ok");
  assert.equal(summarizeNodeResult([[1, 0.15, "Moved", "301"]]).state, "redirect");
  assert.equal(summarizeNodeResult([[1, 0.15, "Unauthorized", "401"]]).state, "auth-required");
  assert.equal(summarizeNodeResult([[0, 10, "Timeout", null]]).state, "failed");
  assert.equal(summarizeNodeResult([[0, 0.1, "Forbidden", "403"]]).state, "failed");
});

test("missing and unknown results never masquerade as successes", () => {
  assert.equal(summarizeNodeResult(null).state, "unknown");
  assert.equal(summarizeNodeResult({ status: "success" }).state, "unknown");
  assert.equal(summarizeNodeResult([]).state, "unknown");
  assert.equal(summarizeNodeResult([[1, 0.1, "unknown", "503"]]).state, "failed");
});
