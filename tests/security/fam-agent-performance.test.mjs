import test from "node:test";
import assert from "node:assert/strict";
import { buildPerformanceReport, renderPerformanceReport } from "../../scripts/fam-agent-performance.mjs";

function diff(path, lines) {
  return [
    "diff --git a/" + path + " b/" + path,
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1 +1 @@",
    "-const oldValue = 1;",
    ...lines.map((line) => "+" + line),
  ].join("\n");
}

test("Performance Agent reports patch size and says runtime profiling was not done", () => {
  const report = buildPerformanceReport(diff("js/example.js", ["const value = 2;"]));
  assert.equal(report.conclusion, "no_static_hotspot");
  assert.equal(report.metrics.added_executable_bytes, Buffer.byteLength("const value = 2;"));
  assert.equal(report.runtime_measurement, "not_performed");
  assert.match(renderPerformanceReport(report), /не выполнялось/);
});

test("Performance Agent rejects an obvious unbounded loop", () => {
  const report = buildPerformanceReport(diff("js/example.js", ["while (true) { work(); }"]));
  assert.equal(report.conclusion, "reject");
  assert.ok(report.findings.some((item) => item.code === "unbounded_loop"));
});

test("Performance Agent flags network and DOM work placed in a loop", () => {
  const report = buildPerformanceReport(diff("js/example.js", [
    "items.forEach((item) => { fetch('/x'); node.querySelector('.row'); });",
  ]));
  assert.equal(report.conclusion, "review_required");
  assert.ok(report.findings.some((item) => item.code === "network_call_inside_iteration"));
  assert.ok(report.findings.some((item) => item.code === "dom_query_inside_iteration"));
});

test("Performance Agent flags newly added external stylesheet resources", () => {
  const report = buildPerformanceReport(diff("css/app.css", ["@import url('https://example.test/font.css');"]));
  assert.equal(report.conclusion, "review_required");
  assert.equal(report.metrics.external_resources_added, 1);
});
