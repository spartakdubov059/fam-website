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
    arrayBuffer: async () => new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)).buffer,
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
        status: "completed",
        path: ".github/workflows/moderation-regression.yml",
        head_branch: "main",
        conclusion: "failure",
        created_at: "2026-11-09T00:00:00Z",
      },
      {
        id: 2,
        workflow_id: 10,
        name: "latest test",
        status: "completed",
        path: ".github/workflows/moderation-regression.yml",
        head_branch: "main",
        conclusion: "success",
        created_at: "2026-11-11T04:59:00Z",
      },
      {
        id: 4,
        workflow_id: 10,
        name: "still running test",
        path: ".github/workflows/moderation-regression.yml",
        head_branch: "main",
        status: "in_progress",
        conclusion: null,
        created_at: "2026-11-11T04:59:30Z",
      },
    ] }),
    baseUrl: siteBase,
    repository: "owner/repo",
    token: "test-token",
    now,
    retryDelayMs: 0,
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 5);
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
          status: "completed",
          path: ".github/workflows/checks.yml",
          head_branch: "main",
          conclusion: "failure",
          created_at: "2026-11-11T04:30:00Z",
          html_url: "https://github.com/owner/repo/actions/runs/3",
        }, {
          id: 4,
          workflow_id: 12,
          name: "Still running CI",
          path: ".github/workflows/checks.yml",
          head_branch: "main",
          status: "in_progress",
          conclusion: null,
          created_at: "2026-11-11T04:45:00Z",
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

test("cloud monitor reports main workflows still in progress after two hours", async () => {
  const now = Date.parse("2026-11-13T05:00:00Z");
  const report = await runFAMCloudMonitor({
    fetchImpl: siteFetch({ runs: [{
      id: 5,
      workflow_id: 13,
      name: "Stalled main check",
      path: ".github/workflows/checks.yml",
      head_branch: "main",
      status: "in_progress",
      conclusion: null,
      created_at: "2026-11-13T02:20:00Z",
      run_started_at: "2026-11-13T02:30:00Z",
      html_url: "https://github.com/owner/repo/actions/runs/5",
    }] }),
    baseUrl: siteBase,
    repository: "owner/repo",
    token: "test-token",
    now,
    retryDelayMs: 0,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.recent_failures, []);
  assert.equal(report.stalled_runs.length, 1);
  assert.equal(report.stalled_runs[0].started_at, "2026-11-13T02:30:00Z");
  assert.match(renderFAMCloudMonitorReport(report), /Workflow в работе более 2 часов/);
});

test("cloud monitor measures same-origin page assets and ignores external resources", async () => {
  const html = [
    "<!doctype html><title>FAM — Свои рядом</title>",
    "<script>const famReady = true;</script>",
    '<script src="js/app.js"></script>',
    '<link rel="stylesheet" href="css/site.css">',
    '<img src="assets/logo.svg">',
    '<img src="https://third-party.invalid/pixel.png">',
  ].join("");
  const requests = [];
  const report = await runFAMCloudMonitor({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed.href);
      if (parsed.hostname === "api.github.com") return response({ workflow_runs: [] });
      if (parsed.pathname.endsWith("/robots.txt")) return response(robots);
      if (parsed.pathname.endsWith("/sitemap.xml")) return response(sitemap);
      if (parsed.pathname.endsWith("/js/app.js")) return response("script");
      if (parsed.pathname.endsWith("/css/site.css")) return response("css");
      if (parsed.pathname.endsWith("/assets/logo.svg")) return response("logo");
      return response(html);
    },
    baseUrl: siteBase,
    repository: "owner/repo",
    token: "test-token",
    now: Date.parse("2026-11-13T05:00:00Z"),
    retryDelayMs: 0,
  });

  assert.equal(report.ok, true);
  assert.equal(report.performance.local_resources_total, 3);
  assert.equal(report.performance.local_resources_checked, 3);
  assert.equal(report.performance.resource_bytes, 13);
  assert.equal(report.performance.largest_resource_bytes, 6);
  assert.equal(requests.some((url) => url.includes("third-party.invalid")), false);
  assert.match(renderFAMCloudMonitorReport(report), /browser rendering, Core Web Vitals/);
  assert.match(report.checks.find((check) => check.name.startsWith("Производительность")).detail, /мс/);
});

test("cloud monitor fails when a same-origin page asset is unavailable", async () => {
  const html = [
    "<!doctype html><title>FAM — Свои рядом</title>",
    "<script>const famReady = true;</script>",
    '<script src="js/missing.js"></script>',
  ].join("");
  const report = await runFAMCloudMonitor({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "api.github.com") return response({ workflow_runs: [] });
      if (parsed.pathname.endsWith("/robots.txt")) return response(robots);
      if (parsed.pathname.endsWith("/sitemap.xml")) return response(sitemap);
      if (parsed.pathname.endsWith("/js/missing.js")) return response("not found", 404);
      return response(html);
    },
    baseUrl: siteBase,
    repository: "owner/repo",
    token: "test-token",
    now: Date.parse("2026-11-13T05:00:00Z"),
    retryDelayMs: 0,
  });

  assert.equal(report.ok, false);
  const performanceCheck = report.checks.find((check) => check.name.startsWith("Производительность"));
  assert.equal(performanceCheck.ok, false);
  assert.match(performanceCheck.detail, /HTTP 404/);
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
  assert.match(summary, /\[&#91;untrusted&#93;&#40;https:\/\/bad\.invalid&#41;\]\(https:\/\/github\.com/);
  assert.doesNotMatch(summary, /&&#35;/);
});
