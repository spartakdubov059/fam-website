import { appendFileSync } from "node:fs";
import { Script } from "node:vm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SITE_BASE_URL = "https://spartakdubov059.github.io/fam-website/";
const DEFAULT_REPOSITORY = "spartakdubov059/fam-website";
const MONITOR_WORKFLOW_PATH = ".github/workflows/fam-cloud-monitor.yml";
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_RUN_MS = 2 * 60 * 60 * 1000;

function safeText(value, limit = 240) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, limit);
}

function escapeMarkdown(value, limit = 240) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "`": "&#96;",
    "[": "&#91;",
    "]": "&#93;",
    "(": "&#40;",
    ")": "&#41;",
    "|": "&#124;",
    "*": "&#42;",
    "_": "&#95;",
    "~": "&#126;",
    "#": "&#35;",
  };
  return safeText(value, limit).replace(/[&<>`\[\]()|*_~#]/g, (character) => entities[character]);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchWithRetry(fetchImpl, url, options, retryDelayMs) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, options);
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError ?? new Error("Network request failed.");
}

function validateHomepage(html) {
  if (!/<title\b[^>]*>\s*FAM\s*[—-]\s*Свои рядом\s*<\/title>/i.test(html)) {
    throw new Error("Expected FAM homepage title was not found.");
  }
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]))
    .map((match) => match[2])
    .filter((source) => source.trim().length > 0);
  if (inlineScripts.length === 0) throw new Error("No inline application script was found.");
  inlineScripts.forEach((source, index) => {
    new Script(source, { filename: "production-inline-" + (index + 1) + ".js" });
  });
}

function localAssetCandidates(html, baseUrl, limit = 12) {
  const candidates = [];
  const assetTag = /<(script|img)\b([^>]*)>/gi;
  for (const match of html.matchAll(assetTag)) {
    const src = match[2].match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (src?.[2]) candidates.push(src[2]);
  }
  const linkTag = /<link\b([^>]*)>/gi;
  for (const match of html.matchAll(linkTag)) {
    const attrs = match[1];
    const rel = attrs.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() ?? "";
    const as = attrs.match(/\bas\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).some((item) => item === "stylesheet" || (item === "preload" && ["style", "script", "image"].includes(as)))) continue;
    const href = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (href) candidates.push(href);
  }

  const base = new URL(baseUrl);
  const urls = [];
  for (const value of candidates) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
      if (!urls.includes(url.href)) urls.push(url.href);
    } catch {
      // Ignore malformed and non-HTTP asset references.
    }
  }
  return { urls: urls.slice(0, limit), total: urls.length };
}

async function measurePagePerformance(html, baseUrl, fetchImpl, retryDelayMs) {
  const extracted = localAssetCandidates(html, baseUrl);
  const results = await Promise.all(extracted.urls.map(async (url) => {
    try {
      const started = performance.now();
      const response = await fetchWithRetry(fetchImpl, url, {
        method: "HEAD",
        headers: { "User-Agent": "FAM-cloud-monitor" },
        signal: AbortSignal.timeout(15_000),
      }, retryDelayMs);
      if (response.status !== 200) throw new Error("HTTP " + response.status);
      const finalUrl = response.url ? new URL(response.url) : new URL(url);
      if (finalUrl.origin !== new URL(baseUrl).origin) throw new Error("Unexpected cross-origin redirect.");
      const contentLength = response.headers?.get?.("content-length") ?? "";
      const bytes = /^\d+$/.test(contentLength) ? Number(contentLength) : null;
      return { ok: true, bytes, elapsed_ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, error: safeText(error?.message || "Resource request failed.", 120) };
    }
  }));

  const successful = results.filter((item) => item.ok);
  const failures = results.filter((item) => !item.ok);
  const knownSizes = successful.filter((item) => Number.isSafeInteger(item.bytes));
  const resourceBytes = knownSizes.reduce((sum, item) => sum + item.bytes, 0);
  const largestResourceBytes = knownSizes.reduce((largest, item) => Math.max(largest, item.bytes), 0);
  return {
    local_resources_total: extracted.total,
    local_resources_checked: extracted.urls.length,
    resources_truncated: Math.max(0, extracted.total - extracted.urls.length),
    resource_bytes: resourceBytes,
    resource_sizes_known: knownSizes.length,
    resource_sizes_unknown: successful.length - knownSizes.length,
    largest_resource_bytes: largestResourceBytes,
    resource_failures: failures.length,
    slowest_resource_ms: successful.reduce((largest, item) => Math.max(largest, item.elapsed_ms), 0),
    resource_errors: failures.slice(0, 4).map((item) => item.error),
  };
}

function mostRecentRuns(runs, sinceMs) {
  const latest = new Map();
  for (const run of runs) {
    if (run?.head_branch !== "main" || run?.path === MONITOR_WORKFLOW_PATH || run?.status !== "completed") continue;
    const createdAt = Date.parse(run?.created_at ?? "");
    if (!Number.isFinite(createdAt) || createdAt < sinceMs) continue;
    const key = String(run.workflow_id ?? run.name ?? run.id ?? "unknown");
    const previous = latest.get(key);
    if (!previous || createdAt > previous.createdAt) latest.set(key, { run, createdAt });
  }
  return [...latest.values()].map(({ run }) => run);
}

function staleInProgressRuns(runs, staleBeforeMs) {
  return runs.filter((run) => {
    if (run?.head_branch !== "main" || run?.path === MONITOR_WORKFLOW_PATH || run?.status !== "in_progress") return false;
    const startedAt = Date.parse(run?.run_started_at ?? run?.created_at ?? "");
    return Number.isFinite(startedAt) && startedAt < staleBeforeMs;
  });
}

function validatedRunUrl(value, repository) {
  try {
    const url = new URL(value);
    const expectedPrefix = "/" + repository + "/actions/runs/";
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(expectedPrefix)
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export async function runFAMCloudMonitor({
  fetchImpl = globalThis.fetch,
  baseUrl = SITE_BASE_URL,
  repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
  token = process.env.GH_TOKEN || "",
  now = Date.now(),
  retryDelayMs = 1000,
} = {}) {
  const checks = [];
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";

  async function checkPage(name, path, validate) {
    const url = new URL(path, base).href;
    try {
      const started = performance.now();
      const response = await fetchWithRetry(fetchImpl, url, {
        headers: { "User-Agent": "FAM-cloud-monitor" },
        signal: AbortSignal.timeout(15_000),
      }, retryDelayMs);
      const body = await response.text();
      if (response.status !== 200) throw new Error("HTTP " + response.status);
      if (validate) validate(body);
      const elapsedMs = Math.round(performance.now() - started);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      checks.push({ name, ok: true, detail: "HTTP 200 · " + elapsedMs + " ms · " + bodyBytes + " decoded bytes", url });
      return { body, elapsed_ms: elapsedMs, body_bytes: bodyBytes };
    } catch (error) {
      checks.push({ name, ok: false, detail: safeText(error?.message || "Request failed."), url });
      return null;
    }
  }

  const homepageResult = await checkPage("Главная и синтаксис встроенного JS", "", validateHomepage);
  let performanceMetrics = null;
  if (homepageResult) {
    const measured = await measurePagePerformance(homepageResult.body, base, fetchImpl, retryDelayMs);
    performanceMetrics = { homepage_ms: homepageResult.elapsed_ms, html_bytes: homepageResult.body_bytes, ...measured };
    const resourceSummary = measured.resource_failures
      ? "Некоторые локальные ресурсы не загрузились: " + measured.resource_errors.join("; ")
      : "Все проверенные локальные ресурсы доступны.";
    checks.push({
      name: "Производительность: документ и локальные ресурсы",
      ok: measured.resource_failures === 0,
      detail: "HTML " + homepageResult.body_bytes + " байт за " + homepageResult.elapsed_ms + " мс; " +
        measured.local_resources_checked + "/" + measured.local_resources_total + " локальных ресурсов проверено, " +
        measured.resource_bytes + " байт по HEAD-заголовкам (" + measured.resource_sizes_known + "/" +
        measured.local_resources_checked + " размеров известно), крупнейший " + measured.largest_resource_bytes +
        " байт, медленнейший " + measured.slowest_resource_ms + " мс. " + resourceSummary +
        (measured.resources_truncated ? " Остальные ресурсы не проверялись из-за лимита 12." : "") +
        " Это сетевой замер с runner, не browser-render/mobile benchmark.",
    });
  } else {
    checks.push({
      name: "Производительность: документ и локальные ресурсы",
      ok: false,
      detail: "Метрики недоступны: главная страница не прошла проверку.",
    });
  }
  await checkPage("robots.txt", "robots.txt", (body) => {
    if (!/^User-agent:\s*\*/im.test(body) || !body.includes(new URL("sitemap.xml", base).href)) {
      throw new Error("robots.txt is missing the allow rule or sitemap link.");
    }
  });
  await checkPage("sitemap.xml", "sitemap.xml", (body) => {
    if (!body.includes("<urlset") || !body.includes(new URL("", base).href)) {
      throw new Error("sitemap.xml is missing the FAM homepage.");
    }
  });

  let recentRuns = [];
  let staleRuns = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    checks.push({ name: "Недавние GitHub Actions на main", ok: false, detail: "Read-only GitHub access is not configured." });
  } else {
    const url = "https://api.github.com/repos/" + repository + "/actions/runs?branch=main&per_page=100";
    try {
      const response = await fetchWithRetry(fetchImpl, url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      }, retryDelayMs);
      if (response.status !== 200) throw new Error("GitHub API HTTP " + response.status);
      const result = await response.json();
      if (!Array.isArray(result?.workflow_runs)) throw new Error("GitHub Actions returned an invalid run list.");
      recentRuns = mostRecentRuns(result.workflow_runs, now - FAILURE_WINDOW_MS);
      staleRuns = staleInProgressRuns(result.workflow_runs, now - STALE_RUN_MS);
      const failures = recentRuns.filter((run) => run.conclusion === "failure");
      checks.push({
        name: "Недавние GitHub Actions на main",
        ok: failures.length === 0 && staleRuns.length === 0,
        detail: [
          failures.length
            ? "Завершились ошибкой: " + failures.map((run) => safeText(run.name, 100)).join(", ")
            : "Ошибок в завершённых запусках за 24 часа нет.",
          staleRuns.length
            ? "Работают дольше 2 часов: " + staleRuns.map((run) => safeText(run.name, 100)).join(", ")
            : "Зависших запусков старше 2 часов нет.",
        ].join(" "),
      });
    } catch (error) {
      checks.push({ name: "Недавние GitHub Actions на main", ok: false, detail: safeText(error?.message || "GitHub API request failed.") });
    }
  }

  const recentFailures = recentRuns
    .filter((run) => run.conclusion === "failure")
    .map((run) => ({
      name: safeText(run.name || "Workflow", 100),
      created_at: safeText(run.created_at || "", 40),
      url: validatedRunUrl(run.html_url, repository),
    }));
  const stalledRuns = staleRuns.map((run) => ({
    name: safeText(run.name || "Workflow", 100),
    started_at: safeText(run.run_started_at || run.created_at || "", 40),
    url: validatedRunUrl(run.html_url, repository),
  }));

  return {
    checked_at: new Date(now).toISOString(),
    cadence_minutes: 30,
    ok: checks.every((check) => check.ok),
    checks,
    recent_failures: recentFailures,
    stalled_runs: stalledRuns,
    performance: performanceMetrics,
  };
}

export function renderFAMCloudMonitorReport(report) {
  const rows = (report?.checks || []).map((check) =>
    "| " + escapeMarkdown(check.name, 100) + " | " + (check.ok ? "OK" : "ОШИБКА") + " | " +
    escapeMarkdown(check.detail, 300) + " |"
  );
  const failures = (report?.recent_failures || []).map((failure) => {
    const name = escapeMarkdown(failure.name, 100);
    return failure.url
      ? "- [" + name + "](" + failure.url + ") — " + escapeMarkdown(failure.created_at, 40)
      : "- " + name + " — " + escapeMarkdown(failure.created_at, 40);
  });
  return [
    "## FAM cloud monitoring",
    "",
    "- Проверено: " + escapeMarkdown(report?.checked_at || "неизвестно", 40),
    "- Периодичность: каждые 30 минут; это периодическая проверка, не непрерывный мониторинг.",
    "- Итог: " + (report?.ok === true ? "все проверки прошли" : "обнаружена ошибка"),
    "",
    "| Проверка | Статус | Детали |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Замеры производительности страницы",
    "",
    report?.performance
      ? "- Документ: " + report.performance.html_bytes + " байт; ответ за " + report.performance.homepage_ms + " мс."
      : "- Замер документа недоступен.",
    report?.performance
      ? "- Локальные ресурсы: " + report.performance.local_resources_checked + "/" + report.performance.local_resources_total +
        " проверено; " + report.performance.resource_bytes + " байт суммарно; крупнейший " +
        report.performance.largest_resource_bytes + " байт; медленнейший " + report.performance.slowest_resource_ms + " мс."
      : "- Ресурсы страницы не измерены.",
    "- Это периодический сетевой замер с GitHub runner; он не измеряет browser rendering, Core Web Vitals или мобильные устройства.",
    "",
    "## Ошибки workflow за последние 24 часа",
    "",
    ...(failures.length ? failures : ["Ошибок в последних завершённых запусках на main не обнаружено."]),
    "",
    "## Workflow в работе более 2 часов",
    "",
    ...((report?.stalled_runs || []).length
      ? report.stalled_runs.map((run) => {
          const name = escapeMarkdown(run.name, 100);
          const started = escapeMarkdown(run.started_at, 40);
          return run.url ? "- [" + name + "](" + run.url + ") — с " + started : "- " + name + " — с " + started;
        })
      : ["Таких запусков не обнаружено."]),
    "",
  ].join("\n");
}

const isMainModule = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const report = await runFAMCloudMonitor();
  const markdown = renderFAMCloudMonitorReport(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  process.stdout.write(markdown);
  if (!report.ok) process.exitCode = 1;
}
