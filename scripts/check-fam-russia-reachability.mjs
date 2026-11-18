// Public-only Russian network diagnostics for FAM. No user data or secrets.
// Check-Host documents its API at https://check-host.net/about/api.
// A successful status from a datacenter cannot guarantee availability on a
// student's home/mobile ISP, nor does it prove a complete JavaScript page load.
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const NODES = [
  "ru1.node.check-host.net",
  "ru2.node.check-host.net",
  "ru3.node.check-host.net",
  "de1.node.check-host.net",
];

export const TARGETS = [
  { name: "FAM Netlify", url: "https://famru.netlify.app/" },
  { name: "FAM redirect health marker", url: "https://famru.netlify.app/fam-domain-health.json" },
  { name: "FAM GitHub Pages", url: "https://spartakdubov059.github.io/fam-website/" },
  { name: "FAM Supabase API", url: "https://tfacqpljrvfpcrhdovbu.supabase.co/auth/v1/health" },
  { name: "FAM Supabase JS CDN", url: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0" },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function summarizeNodeResult(raw) {
  if (!Array.isArray(raw) || !Array.isArray(raw[0])) return { state: "unknown", status: "—", info: "Неизвестно / не завершено" };
  const result = raw[0];
  const status = String(result[3] ?? "—");
  if (result[0] === 1 && /^2\d\d$/.test(status)) {
    return { state: "ok", status, info: "HTTP успешен" };
  }
  if (result[0] === 1 && /^3\d\d$/.test(status)) {
    return { state: "redirect", status, info: "HTTP перенаправление" };
  }
  // Check-Host marks 4xx responses as failed HTTP probes even when the
  // remote server answered. A 401 from the auth health endpoint proves reachability.
  if (status === "401") {
    return { state: "auth-required", status, info: "Узел дошёл до API; endpoint требует авторизацию" };
  }
  return {
    state: "failed",
    status,
    info: String(result[2] ?? "Сбой соединения / HTTP").slice(0, 75).replace(/[|\n\r]/g, " "),
  };
}

async function getJSON(url, timeoutMs = 15000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "FAM-Public-Network-Audit/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429 && attempt === 0) {
      const seconds = Number(response.headers?.get?.("retry-after"));
      const delayMs = Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1000, 60000) : 15000;
      await sleep(delayMs);
      continue;
    }
    if (!response.ok) throw new Error("Check-Host API HTTP " + response.status);
    return await response.json();
  }
  throw new Error("Check-Host request could not be completed");
}

// A service check is complete only when every requested node finished;
// API rate limits or missing nodes must never count as success.
export function diagnosticCoverage(completedTargets, requiredTargets = TARGETS.length) {
  return Number.isInteger(completedTargets) && requiredTargets > 0 &&
    completedTargets === requiredTargets ? "complete" : "inconclusive";
}

export function hasFailedNodes(nodes) {
  return Array.isArray(nodes) && nodes.some(node => node.state === "failed");
}

export async function checkHost(target) {
  const url = new URL("https://check-host.net/check-http");
  url.searchParams.set("host", target.url);
  for (const node of NODES) url.searchParams.append("node", node);

  const created = await getJSON(url);
  if (created?.ok !== 1 || typeof created.request_id !== "string") {
    throw new Error("Check-Host did not accept this diagnostic request");
  }
  const selected = Object.keys(created.nodes ?? {}).filter(node => NODES.includes(node));
  if (!selected.length) throw new Error("Check-Host returned no requested nodes");

  let result = {};
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(2200);
    result = await getJSON("https://check-host.net/check-result/" + encodeURIComponent(created.request_id));
    if (selected.every(node => result[node] != null)) break;
  }
  return {
    target,
    report: typeof created.permanent_link === "string" ? created.permanent_link : "https://check-host.net/",
    nodes: selected.map(node => ({
      node,
      ...summarizeNodeResult(result[node]),
    })),
  };
}

async function main() {
  const lines = [
    "## FAM: доступность из российских дата-центров",
    "",
    "Разовая проверка Check-Host, **не** замер домашнего интернета школьников. HTTP-ответ не доказывает загрузку всего JavaScript и успешный вход.",
    "",
    "| Хост | Узел | Результат | HTTP | Отчёт |",
    "|---|---|---|---|---|",
  ];
  let checks = 0;
  let failedTargets = 0;
  for (const target of TARGETS) {
    try {
      const result = await checkHost(target);
      if (result.nodes.length && result.nodes.every(node => node.state !== "unknown")) checks++;
      if (hasFailedNodes(result.nodes)) failedTargets++;
      for (const node of result.nodes) {
        lines.push("| " + target.name + " | " + node.node.replace(".node.check-host.net", "") +
          " | " + node.info + " | " + node.status + " | [Источник](" + result.report + ") |");
      }
      console.log(target.name + ": " + result.nodes.map(n => n.node.split(".")[0] + "=" + n.state + "(" + n.status + ")").join(", ") + " — " + result.report);
    } catch (error) {
      lines.push("| " + target.name + " | — | Проверка не выполнена: " +
        String(error?.message || "Unknown error").replace(/[|\n\r]/g, " ").slice(0,85) + " | — | — |");
      console.warn(target.name + ": diagnostic unavailable (" + String(error?.message || "unknown") + ")");
    }
  }
  lines.push("", "Полностью проверено целей: " + checks + "/" + TARGETS.length + ".");
  if (failedTargets) {
    lines.push("❌ Проблемные HTTP-проверки: " + failedTargets + ". Проверьте источники и повторите диагностику.");
    console.warn("::warning::FAM reachability detected failed host checks; inspect diagnostic report.");
    process.exitCode = 1;
  }
  if (diagnosticCoverage(checks) !== "complete") {
    lines.push("⚠️ Диагностика неполная: это НЕ подтверждение доступности всех доменов.");
    console.warn("::warning::FAM reachability diagnostic incomplete; do not claim all hosts are healthy.");
    process.exitCode = 2;
  }
  const summary = lines.join("\n") + "\n";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  // API errors are inconclusive, not proof that any host is blocked.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.warn("Network diagnostic inconclusive:", String(error?.message || error));
    process.exitCode = 2;
  });
}
