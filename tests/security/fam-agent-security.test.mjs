import test from "node:test";
import assert from "node:assert/strict";
import { buildSecurityReport, renderSecurityReport } from "../../scripts/fam-agent-security.mjs";

function diff(path, line) {
  return [
    "diff --git a/" + path + " b/" + path,
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1 +1 @@",
    "-" + (path.endsWith(".js") ? "const safe = true;" : "old"),
    "+" + line,
  ].join("\n");
}

test("Security Agent reports a clean allowed patch without claiming full security", () => {
  const report = buildSecurityReport(diff("js/example.js", "const safe = true;"));
  assert.equal(report.conclusion, "no_static_finding");
  assert.equal(report.manual_approval_required, true);
  assert.match(renderSecurityReport(report), /не заменяет аудит runtime/);
});

test("Security Agent rejects likely secret literals without echoing values", () => {
  const token = "ghp_" + "A".repeat(32);
  const report = buildSecurityReport(diff("js/example.js", 'const apiKey = "' + token + '";'));
  assert.equal(report.conclusion, "reject");
  assert.equal(report.findings[0].code, "possible_secret_literal");
  assert.doesNotMatch(JSON.stringify(report), /ghp_/);
  assert.doesNotMatch(renderSecurityReport(report), /ghp_/);
});

test("Security Agent blocks dynamic execution and escalates network or HTML sinks", () => {
  assert.equal(buildSecurityReport(diff("index.html", "<script>eval('x')</script>")).conclusion, "reject");
  const report = buildSecurityReport(diff("js/example.js", "element.innerHTML = value; fetch('/api');"));
  assert.equal(report.conclusion, "review_required");
  assert.ok(report.findings.some((item) => item.code === "dynamic_html_sink"));
  assert.ok(report.findings.some((item) => item.code === "outbound_network_change"));
});

test("Security Agent rejects a path outside the agent allowlist", () => {
  const report = buildSecurityReport(diff("supabase/migrations/unsafe.sql", "grant all;"));
  assert.equal(report.conclusion, "reject");
  assert.ok(report.findings.some((item) => item.code === "path_outside_allowlist"));
});
