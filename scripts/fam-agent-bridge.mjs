import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const TASK_PROMPTS = Object.freeze({
  audit_frontend_runtime:
    "Проведи узкий аудит клиентской обработки ошибок JavaScript FAM. Код публичного интерфейса и встроенный JavaScript находятся в корневом index.html; каталогов js/ и css/ в репозитории нет. Обязательно включи index.html в список файлов для анализа. Проверь window.onerror, window.onunhandledrejection и reportFamSiteError. Ищи только воспроизводимые ошибки в публичном интерфейсе; не меняй Auth, безопасность, модерацию, серверные функции или базу данных.",
  audit_client_resilience:
    "Проведи узкий аудит устойчивости загрузки публичных объявлений FAM. Ищи только безопасную обработку сетевых ошибок и пустых ответов; не читай и не изменяй пользовательские записи.",
  audit_accessibility:
    "Проведи узкий аудит доступности публичного интерфейса FAM: клавиатурная навигация, подписи элементов и фокус. Не меняй Auth, безопасность, серверные функции или базу данных.",
});

const EVENT_CODES = new Set([
  "js_runtime", "unhandled_rejection", "supabase_sdk_unavailable",
  "listings_load_failed", "notifications_load_failed",
  "database_request_failed", "auth_backend_failed",
]);
const PAGE_AREAS = new Set(["auth", "listings", "notifications", "database", "other"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateClaimResponse(data) {
  if (!data || typeof data !== "object" || data.ok !== true) {
    throw new Error("Bridge claim failed.");
  }
  if (data.task === null) return null;
  const task = data.task;
  if (
    !task || typeof task !== "object" ||
    !UUID_RE.test(task.id) ||
    !Object.hasOwn(TASK_PROMPTS, task.task_key) ||
    !EVENT_CODES.has(task.event_code) ||
    !PAGE_AREAS.has(task.page_area) ||
    !Number.isSafeInteger(task.occurrences) ||
    task.occurrences < 0 || task.occurrences > 1000
  ) throw new Error("Bridge returned an invalid task.");
  return Object.freeze({
    id: task.id,
    task_key: task.task_key,
    prompt: TASK_PROMPTS[task.task_key] +
      " Контекст: код события " + task.event_code +
      ", раздел " + task.page_area +
      ", агрегированное число событий " + task.occurrences + ".",
  });
}

export async function readTaskSummary(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function chooseResultCode(summary, executionSucceeded = true) {
  if (!executionSucceeded) return "model_failed";
  if (!summary || typeof summary !== "object") return "model_failed";
  if (summary.finding_status === "blocked") return "model_blocked";
  if (summary.finding_status === "issue_found" && summary.patch_available === true) {
    return "model_completed";
  }
  return "model_no_patch";
}

export async function bridgeRequest({ url, token, body, fetchImpl = fetch }) {
  if (!url || !token) throw new Error("Bridge credentials are not configured.");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fam-agent-token": token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Bridge request failed with HTTP " + response.status);
  return response.json();
}

async function main() {
  const mode = process.argv[2];
  const output = process.env.GITHUB_OUTPUT;
  const envFile = process.env.GITHUB_ENV;
  const url = process.env.FAM_AGENT_BRIDGE_URL || "";
  const token = process.env.FAM_AGENT_WORKER_TOKEN || "";
  const manualTask = (process.env.FAM_MANUAL_TASK || "").trim();

  if (mode === "claim") {
    if (manualTask) {
      if (manualTask.length > 3000) throw new Error("Manual task exceeds 3000 characters.");
      if (envFile) appendFileSync(envFile, "FAM_TASK=" + manualTask.replace(/\r?\n/g, " ") + "\n");
      if (output) appendFileSync(output, "claimed=false\n");
      return;
    }
    if (!url || !token) {
      if (output) appendFileSync(output, "claimed=false\n");
      console.log("Bridge secrets are absent; using the existing scheduled audit.");
      return;
    }
    const data = await bridgeRequest({ url, token, body: { action: "claim" } });
    const task = validateClaimResponse(data);
    if (!task) {
      if (output) appendFileSync(output, "claimed=false\n");
      console.log("No queued coder task; using the existing scheduled audit.");
      return;
    }
    if (envFile) appendFileSync(envFile,
      "FAM_TASK=" + task.prompt + "\nFAM_CODER_TASK_ID=" + task.id + "\n");
    if (output) appendFileSync(output, "claimed=true\n");
    console.log("Claimed one allowlisted technical task; task contents are aggregate-only.");
    return;
  }

  if (mode === "finish") {
    const taskId = process.env.FAM_CODER_TASK_ID || "";
    if (!taskId) return;
    const summary = await readTaskSummary(process.env.FAM_SUMMARY_PATH || "");
    const code = chooseResultCode(summary, process.env.FAM_MODEL_STEP_OUTCOME === "success");
    const result = await bridgeRequest({
      url, token, body: { action: "finish", task_id: taskId, result_code: code },
    });
    if (result?.ok !== true || result?.saved !== true) {
      throw new Error("Bridge did not accept the task result.");
    }
    console.log("Coder task finished with allowlisted result code: " + code);
    return;
  }

  throw new Error("Usage: node scripts/fam-agent-bridge.mjs claim|finish");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
