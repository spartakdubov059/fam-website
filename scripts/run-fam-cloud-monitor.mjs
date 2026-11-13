import { appendFileSync } from "node:fs";
import { Script } from "node:vm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SITE_BASE_URL = "https://spartakdubov059.github.io/fam-website/";
const DEFAULT_REPOSITORY = "spartakdubov059/fam-website";
const MONITOR_WORKFLOW_PATH = ".github/workflows/fam-cloud-monitor.yml";
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

function latestMainRuns(runs) {
  const latest = new Map();
  for (const run of runs) {
    if (run?.head_branch !== "main" || run?.path === MONITOR_WORKFLOW_PATH) continue;
    const createdAt = Date.parse(run?.created_at ?? "");
    if (!Number.isFinite(createdAt)) continue;
    const key = String(run.workflow_id ?? run.name ?? run.id ?? "unknown");
    const previous = latest.get(key);
    if (!previous || createdAt > previous.createdAt) latest.set(key, { run, createdAt });
  }
  return [...latest.values()].map(({ run }) => run);
}

function inspectCoderWorkflow(runs, nowMs) {
  const run = runs.find((item) =>
    item?.path === ".github/workflows/fam-codex-developer.yml" ||
    item?.name === "FAM local AI developer"
  );
  if (!run) {
    return { ok: false, detail: "За последние 100 запусков main не найден запуск облачного Qwen-разработчика." };
  }

  const createdAt = Date.parse(run.created_at ?? "");
  if (!Number.isFinite(createdAt)) {
    return { ok: false, detail: "У последнего запуска Qwen отсутствует корректное время." };
  }

  const ageMs = nowMs - createdAt;
  if (ageMs < -5 * 60 * 1000) {
    return { ok: false, detail: "Время последнего запуска Qwen находится в будущем." };
  }
  if (ageMs > 30 * 60 * 60 * 1000) {
    return { ok: false, detail: "Ежедневный запуск Qwen просрочен: последний запуск старше 30 часов." };
  }
  if (run.status === "completed" && run.conclusion !== "success") {
    return {
      ok: false,
      detail: "Последний запуск Qwen завершился со статусом: " + safeText(run.conclusion || "неизвестно", 40) + ".",
    };
  }
  if (run.status !== "completed" && !["queued", "in_progress", "requested", "waiting"].includes(run.status)) {
    return {
      ok: false,
      detail: "Последний запуск Qwen имеет неподтверждённый статус: " + safeText(run.status || "неизвестно", 40) + ".",
    };
  }
  if (run.status !== "completed" && ageMs > 2 * 60 * 60 * 1000) {
    return { ok: false, detail: "Запуск Qwen остаётся в очереди или выполняется более двух часов." };
  }
  if (run.status === "completed") {
    return { ok: true, detail: "Последний запуск Qwen завершился успешно менее 30 часов назад." };
  }
  return { ok: true, detail: "Последний запуск Qwen сейчас выполняется или ожидает runner." };
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
      const response = await fetchWithRetry(fetchImpl, url, {
        headers: { "User-Agent": "FAM-cloud-monitor" },
        signal: AbortSignal.timeout(15_000),
      }, retryDelayMs);
      const body = await response.text();
      if (response.status !== 200) throw new Error("HTTP " + response.status);
      if (validate) validate(body);
      checks.push({ name, ok: true, detail: "HTTP 200", url });
    } catch (error) {
      checks.push({ name, ok: false, detail: safeText(error?.message || "Request failed."), url });
    }
  }

  await checkPage("Главная и синтаксис встроенного JS", "", validateHomepage);
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
      const latestRuns = latestMainRuns(result.workflow_runs);
      recentRuns = latestRuns.filter((run) => {
        const createdAt = Date.parse(run?.created_at ?? "");
        return Number.isFinite(createdAt) && createdAt >= now - FAILURE_WINDOW_MS;
      });
      const failures = recentRuns.filter((run) => run.conclusion === "failure");
      checks.push({
        name: "Недавние GitHub Actions на main",
        ok: failures.length === 0,
        detail: failures.length === 0
          ? "Последние найденные запуски workflow за 24 часа не завершились ошибкой."
          : "Есть workflow с последним запуском в ошибке: " + failures.map((run) => safeText(run.name, 100)).join(", "),
      });

      const coderHealth = inspectCoderWorkflow(latestRuns, now);
      checks.push({
        name: "Ежедневный запуск локального Qwen",
        ok: coderHealth.ok,
        detail: coderHealth.detail,
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

  return {
    checked_at: new Date(now).toISOString(),
    cadence_minutes: 30,
    ok: checks.every((check) => check.ok),
    checks,
    recent_failures: recentFailures,
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
    "## Ошибки workflow за последние 24 часа",
    "",
    ...(failures.length ? failures : ["Ошибок в последних запусках на main не обнаружено."]),
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
