import test from "node:test";
import assert from "node:assert/strict";
import { NODES, TARGETS, summarizeNodeResult, diagnosticCoverage, hasFailedNodes } from "../../scripts/check-fam-russia-reachability.mjs";

test("public diagnostic uses bounded approved endpoints and Russian + EU controls", () => {
  assert.equal(NODES.length, 4);
  assert.ok(NODES.includes("ru1.node.check-host.net"));
  assert.ok(NODES.includes("ru2.node.check-host.net"));
  assert.ok(NODES.includes("ru3.node.check-host.net"));
  assert.ok(NODES.includes("de1.node.check-host.net"));
  assert.equal(TARGETS.length, 5);
  assert.ok(TARGETS.some(t => t.name === "FAM Netlify readiness marker" &&
    t.url === "https://famru.netlify.app/fam-domain-health.json"));
  assert.ok(TARGETS.every(t => t.url.startsWith("https://")));
});

test("check-host HTTP success and redirects are interpreted separately", () => {
  assert.equal(summarizeNodeResult([[1, 0.15, "OK", "200"]]).state, "ok");
  assert.equal(summarizeNodeResult([[1, 0.15, "Moved", "301"]]).state, "redirect");
  assert.equal(summarizeNodeResult([[1, 0.15, "Unauthorized", "401"]]).state, "auth-required");
  // Check-Host's first tuple element is often 0 for HTTP 401 despite a real reply.
  assert.equal(summarizeNodeResult([[0, 0.15, "Unauthorized", "401"]]).state, "auth-required");
  assert.equal(summarizeNodeResult([[0, 10, "Timeout", null]]).state, "failed");
  assert.equal(summarizeNodeResult([[0, 0.1, "Forbidden", "403"]]).state, "failed");
});

test("missing and unknown results never masquerade as successes", () => {
  assert.equal(summarizeNodeResult(null).state, "unknown");
  assert.equal(summarizeNodeResult({ status: "success" }).state, "unknown");
  assert.equal(summarizeNodeResult([]).state, "unknown");
  assert.equal(summarizeNodeResult([[1, 0.1, "unknown", "503"]]).state, "failed");
});

test("incomplete Russian network diagnostics never report full coverage", () => {
  assert.equal(diagnosticCoverage(5, 5), "complete");
  assert.equal(diagnosticCoverage(1, 5), "inconclusive");
  assert.equal(diagnosticCoverage(0, 5), "inconclusive");
  assert.equal(diagnosticCoverage(6, 5), "inconclusive");
  assert.equal(diagnosticCoverage(0, 0), "inconclusive");
});

test("completed responses with a failed Russian node are not healthy", () => {
  const nodes = [
    summarizeNodeResult([[1, 0.1, "OK", "200"]]),
    summarizeNodeResult([[0, 15, "Timeout", null]]),
  ];
  assert.equal(hasFailedNodes(nodes), true);
  assert.equal(hasFailedNodes([summarizeNodeResult([[1, 0.1, "OK", "200"]])]), false);
  assert.equal(hasFailedNodes([summarizeNodeResult([[1, 0.1, "Unauthorized", "401"]])]), false);
  assert.equal(hasFailedNodes([]), false);
});
