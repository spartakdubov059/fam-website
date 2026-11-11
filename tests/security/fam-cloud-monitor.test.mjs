import test from "node:test";
import assert from "node:assert/strict";
import {
  renderFAMCloudMonitorReport,
  runFAMCloudMonitor,
} from "../../scripts/run-fam-cloud-monitor.mjs";

const siteBase = "https://example.invalid/fam-website/";
const homepage = "<!doctype html><title>FAM — Свои рядом</title><script>const famReady = true;</script>";
const robots = "User-agent: *\nAllow: /\nSitemap: https://example.invalid/fam-website/sitemap.xml\n";
const sitemap = "<urlset><url><loc>https://example.invalid/fam-website/</loc></url></urlset>";

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "text/plain" },
    text: async () => body,
    json: async () => body,
  };
}

function siteFetch({ runs = [], statusByPath = {} } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") {
      return response({ workflow_runs: runs });
    }
    const status = statusByPath[parsed.pathname] ?? 200;
    if (parsed.pathname.endsWith("/robots.txt")) return response(robots, status);
    if (parsed.pathname.endsWith("/sitemap.xml")) return response(sitemap, status);
    return response(homepage, status);
  };
}

test("cloud monitor checks production pages and ignores stale GitHub failures", async () => {
  const now = Date.parse("2026-11-11T05:00:00Z");
  const report = await runFAMCloudMonitor({
    fetchImpl: siteFetch({ runs: [
      {
        id: 1,
        workflow_id: 10,
        name: "old failed test",
        path: ".github/workflows/moderation-regression.yml",
        head_branch: "main",
        conclusion: "failure",
        created_at: "2026-11-09T00:00:00Z",
      },
      {
        id: 2,
        workflow_id: 10,
        name: "latest test",
        path: ".github/workflows/moderation-regression.yml",
        head_branch: "main",
        conclusion: "success",
        created_at: "2026-11-11T04:59:00Z",
      },
    ] }),
    baseUrl: siteBase,
    repository: "owner/repo",
    token: "test-token",
    now,
    retryDelayMs: 0,
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 4);
  assert.deepEqual(report.recent_failures, []);
});

test("cloud monitor reports bad homepage markup and recent failed workflows", async () => {
  const now = Date.parse("2026-11-11T05:00:00Z");
  const report = await runFAMCloudMonitor({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "api.github.com") {
        return response({ workflow_runs: [{
          id: 3,
          workflow_id: 12,
          name: "Broken CI",
          path: ".github/workflows/checks.yml",
          head_branch: "main",
          conclusion: "failure",
          created_at: "2026-11-11T04:30:00Z",
          html_url: "https://github.com/owner/repo/actions/runs/3",
        }] });
      }
      if (parsed.pathname.endsWith("/robots.txt")) return response(robots);
      if (parsed.pathname.endsWith("/sitemap.xml")) return response(sitemap);
      return response("<title>Wrong site</title><script>const ok = true;</script>");
    },
    baseUrl: siteBase,
    repository: "owner/repo",
    token: "test-token",
    now,
    retryDelayMs: 0,
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.some((check) => check.name.includes("Главная") && !check.ok), true);
  assert.equal(report.recent_failures.length, 1);
  assert.equal(report.recent_failures[0].url, "https://github.com/owner/repo/actions/runs/3");
});

test("monitor summary distinguishes its cadence and escapes workflow names", () => {
  const summary = renderFAMCloudMonitorReport({
    checked_at: "2026-11-11T05:00:00.000Z",
    cadence_minutes: 30,
    ok: false,
    checks: [{ name: "<script>|test", ok: false, detail: "HTTP 500" }],
    recent_failures: [{
      name: "[untrusted](https://bad.invalid)",
      created_at: "2026-11-11T04:30:00Z",
      url: "https://github.com/owner/repo/actions/runs/2",
    }],
  });

  assert.match(summary, /каждые 30 минут/);
  assert.match(summary, /не непрерывный мониторинг/);
  assert.match(summary, /&lt;script&gt;/);
  assert.doesNotMatch(summary, /\[untrusted\]\(https:\/\/bad\.invalid\)/);
  assert.match(summary, /\[\[untrusted\]\(https:\/\/bad\.invalid\)\]\(https:\/\/github\.com/);
});
