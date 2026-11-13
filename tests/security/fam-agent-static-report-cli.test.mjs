import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeDiff(file, added) {
  return [
    "diff --git a/" + file + " b/" + file,
    "--- a/" + file,
    "+++ b/" + file,
    "@@ -1 +1 @@",
    "-const oldValue = 1;",
    "+" + added,
  ].join("\n");
}

function invoke(script, patch, directory, name) {
  const patchPath = join(directory, name + ".patch");
  const reportPath = join(directory, name + ".json");
  const markdownPath = join(directory, name + ".md");
  writeFileSync(patchPath, patch);
  const result = spawnSync(process.execPath, [
    join(process.cwd(), "scripts", script),
    patchPath, reportPath, markdownPath,
  ], { cwd: process.cwd(), encoding: "utf8" });
  return { result, report: JSON.parse(readFileSync(reportPath, "utf8")), markdown: readFileSync(markdownPath, "utf8") };
}

test("Security and Performance CLIs write safe reports and block their defined critical cases", () => {
  const directory = mkdtempSync(join(tmpdir(), "fam-agent-static-report-"));
  try {
    const cleanPatch = makeDiff("js/example.js", "const value = 2;");
    const securityPass = invoke("fam-agent-security.mjs", cleanPatch, directory, "security-pass");
    assert.equal(securityPass.result.status, 0, securityPass.result.stderr);
    assert.equal(securityPass.report.conclusion, "no_static_finding");
    assert.match(securityPass.markdown, /статический отчёт/);

    const secret = "ghp_" + "B".repeat(32);
    const securityReject = invoke(
      "fam-agent-security.mjs",
      makeDiff("docs/example.md", 'const apiKey = "' + secret + '";'),
      directory,
      "security-reject",
    );
    assert.equal(securityReject.result.status, 1);
    assert.equal(securityReject.report.conclusion, "reject");
    assert.doesNotMatch(readFileSync(join(directory, "security-reject.json"), "utf8"), /ghp_/);

    const perfPass = invoke("fam-agent-performance.mjs", cleanPatch, directory, "performance-pass");
    assert.equal(perfPass.result.status, 0, perfPass.result.stderr);
    assert.equal(perfPass.report.conclusion, "no_static_hotspot");
    assert.equal(perfPass.report.runtime_measurement, "not_performed");

    const perfReject = invoke(
      "fam-agent-performance.mjs",
      makeDiff("js/example.js", "while (true) { work(); }"),
      directory,
      "performance-reject",
    );
    assert.equal(perfReject.result.status, 1);
    assert.equal(perfReject.report.conclusion, "reject");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
