import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const TASK_PROMPTS = Object.freeze({
  audit_frontend_runtime:
    "Проведи узкий аудит клиентской обработки ошибок JavaScript FAM. Код публичного интерфейса и встроенный JavaScript находятся в корневом index.html; каталогов js/ и css/ в репозитории нет. Обязательно включи index.html в список файлов для анализа. Проверь window.onerror, window.onunhandledrejection и reportFamSiteError. Цель: найти подтверждённые ошибки только в публичной обработке ошибок. Scope: index.html; не меняй Auth, безопасность, модерацию, серверные функции, базу данных или данные пользователей. Evidence: checkout и безопасные агрегаты. Acceptance: конкретное место в коде для каждого дефекта; при отсутствии доказательств верни no_patch. Требуемые проверки: git apply --check и независимые security/moderation тесты. Риск низкий, но исполняемые изменения требуют решения владельца. Секреты и личные данные запрещены; миграции и публикация запрещены.",
  audit_client_resilience:
    "Проведи узкий аудит устойчивости загрузки публичных объявлений FAM. Цель: найти подтверждённые ошибки сетевой обработки и пустых ответов. Scope: только публичный интерфейс; не читай записи пользователей. Evidence: checkout и безопасные агрегаты. Acceptance: конкретное место в коде для каждого дефекта; при отсутствии доказательств верни no_patch. Требуемые проверки: git apply --check и независимые security/moderation тесты. Риск низкий, изменения требуют решения владельца. Секреты и личные данные запрещены; миграции и публикация запрещены.",
  audit_accessibility:
    "Проведи узкий аудит доступности публичного интерфейса FAM: клавиатурная навигация, подписи элементов и фокус. Цель: найти подтверждённые дефекты доступности. Scope: только публичный интерфейс; не меняй Auth, безопасность, серверные функции или базу данных. Evidence: checkout и безопасные агрегаты. Acceptance: конкретное место в коде для каждого дефекта; при отсутствии доказательств верни no_patch. Требуемые проверки: git apply --check и независимые security/moderation тесты. Риск низкий, изменения требуют решения владельца. Секреты и личные данные запрещены; миграции и публикация запрещены.",
  audit_agent_infrastructure:
    "Проведи узкую диагностику управляющей инфраструктуры FAM по фиксированному коду сигнала, без чтения журналов GitHub, payload задач и данных пользователей. Scope только: scripts/fam-agent-governance.mjs, scripts/fam-agent-bridge.mjs, .github/workflows/fam-agent-governance.yml, .github/workflows/fam-codex-developer.yml и tests/agent-integration/**. Цель: установить по checkout, есть ли конкретная техническая причина для сигнала и предложить минимальное исправление. Acceptance: если причина не подтверждается кодом — no_patch; если подтверждается — patch с тестами, без секретов, пользовательских данных, Auth/RLS, модерации или auto-merge. Требуемые проверки: git apply --check и полный независимый security/moderation набор. Любой patch инфраструктуры требует review и решения владельца.",
});

export const TASK_CONTRACT = Object.freeze({
  version: 1,
  goal: "Проверить только заранее утверждённую техническую область без данных пользователей.",
  scope: Object.freeze(["index.html", "css/**", "js/**", "docs/**", "tests/**", "scripts/fam-agent-governance.mjs", "scripts/fam-agent-bridge.mjs", ".github/workflows/fam-agent-governance.yml", ".github/workflows/fam-codex-developer.yml"]),
  evidence: "Только код из checkout и безопасные агрегаты: enum кодов событий, зона интерфейса, количество.",
  acceptance: Object.freeze([
    "Каждое утверждение о дефекте подтверждено конкретным местом в коде.",
    "При отсутствии подтверждённого дефекта вернуть no_patch.",
    "Не менять Auth, роли, модерацию, серверные функции, SQL или данные пользователей.",
  ]),
  required_checks: Object.freeze([
    "git apply --check",
    "allowlist and independent security/moderation regression suite",
  ]),
  risk: "low; любые исполняемые изменения требуют владельческого review",
  limits: Object.freeze([
    "Нет секретов, личных данных учеников, произвольных payload или пользовательских сообщений.",
    "Нет auto-merge, публикации или миграций.",
  ]),
});

const EVENT_CODES = new Set([
  "js_runtime", "unhandled_rejection", "supabase_sdk_unavailable",
  "listings_load_failed", "notifications_load_failed",
  "database_request_failed", "auth_backend_failed",
  "ci_workflow_failure", "worker_queue_failure", "worker_expired_lease",
  "qwen_repeated_failure", "qwen_stuck_run", "synthetic_ci_workflow_failure",
]);
const PAGE_AREAS = new Set(["auth", "listings", "notifications", "database", "other", "agent_infrastructure"]);
const INSPECTOR_SIGNAL_CODES = new Set([
  "ci_workflow_failure", "worker_queue_failure", "worker_expired_lease", "synthetic_ci_workflow_failure",
  "qwen_repeated_failure", "qwen_stuck_run",
]);
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
    (task.task_key === "audit_agent_infrastructure" && (task.page_area !== "agent_infrastructure" || !INSPECTOR_SIGNAL_CODES.has(task.event_code) || task.occurrences < 1)) ||
    (task.task_key !== "audit_agent_infrastructure" && task.page_area === "agent_infrastructure") ||
    !Number.isSafeInteger(task.occurrences) ||
    task.occurrences < 0 || task.occurrences > 1000
  ) throw new Error("Bridge returned an invalid task.");
  return Object.freeze({
    id: task.id,
    task_key: task.task_key,
    contract: TASK_CONTRACT,
    prompt: TASK_PROMPTS[task.task_key] +
      " Карточка задачи: " + JSON.stringify(TASK_CONTRACT) +
      ". Контекст: код события " + task.event_code +
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
    return "model_generated";
  }
  return "model_no_patch";
}

export async function bridgeRequest({ url, token, body, fetchImpl = fetch }) {
  if (!url || !token) throw new Error("Bridge credentials are not configured.");
  const requestBody = JSON.stringify(body);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fam-agent-token": token,
    },
    body: requestBody,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    let diagnostic = {};
    try {
      const payload = await response.json();
      if (payload && typeof payload === "object") diagnostic = payload;
    } catch {
      // Non-JSON gateway errors are reported without logging response content.
    }
    const errorCode = typeof diagnostic.error_code === "string" && /^[a-z0-9_]{1,48}$/.test(diagnostic.error_code)
      ? diagnostic.error_code : "unstructured_error";
    const stage = typeof diagnostic.stage === "string" && /^[a-z0-9_]{1,48}$/.test(diagnostic.stage)
      ? diagnostic.stage : "unknown";
    const diagnosticId = typeof diagnostic.diagnostic_id === "string" && /^[0-9a-f-]{36}$/i.test(diagnostic.diagnostic_id)
      ? diagnostic.diagnostic_id : response.headers?.get?.("x-fam-diagnostic-id") || "unavailable";
    const metadata = {
      http_status: response.status,
      error_code: errorCode,
      stage,
      diagnostic_id: diagnosticId,
      action: typeof body.action === "string" ? body.action : "unknown",
      request_bytes: new TextEncoder().encode(requestBody).byteLength,
      task_id_valid: typeof body.task_id === "string" && UUID_RE.test(body.task_id),
      result_code: ["model_no_patch", "model_failed", "model_blocked"].includes(body.result_code) ? body.result_code : undefined,
    };
    console.error("fam_agent_bridge_request_failed", JSON.stringify(metadata));
    throw new Error("Bridge request failed: HTTP " + response.status + " " + errorCode + " at " + stage + " (diagnostic " + diagnosticId + ")");
  }
  return response.json();
}

async function main() {
  const mode = process.argv[2];
  const output = process.env.GITHUB_OUTPUT;
  const envFile = process.env.GITHUB_ENV;
  const url = process.env.FAM_AGENT_BRIDGE_URL || "";
  const token = process.env.FAM_AGENT_WORKER_TOKEN || "";
  if (mode === "claim") {
    if (!url || !token) throw new Error("Safe task bridge is unavailable; model execution is blocked.");
    const data = await bridgeRequest({ url, token, body: { action: "claim" } });
    const task = validateClaimResponse(data);
    if (!task) {
      if (output) appendFileSync(output, "claimed=false\n");
      console.log("No queued coder task; model download and execution are skipped.");
      return;
    }
    if (envFile) appendFileSync(envFile,
      "FAM_TASK=" + task.prompt + "\nFAM_CODER_TASK_ID=" + task.id + "\n");
    if (output) appendFileSync(output, "claimed=true\ntask_id=" + task.id + "\n");
    console.log("Claimed one allowlisted technical task; task contents are aggregate-only.");
    return;
  }

  if (mode === "start") {
    const taskId = process.env.FAM_CODER_TASK_ID || "";
    if (!taskId) return;
    const result = await bridgeRequest({
      url, token, body: { action: "start", task_id: taskId },
    });
    if (result?.ok !== true || result?.started !== true) {
      throw new Error("Bridge did not start the claimed task.");
    }
    if (output) appendFileSync(output, "started=true\n");
    console.log("Task started with a bounded lease.");
    return;
  }

  if (mode === "heartbeat") {
    const taskId = process.env.FAM_CODER_TASK_ID || "";
    if (!taskId) return;
    const result = await bridgeRequest({ url, token, body: { action: "heartbeat", task_id: taskId } });
    if (result?.ok !== true || result?.renewed !== true) {
      throw new Error("Bridge did not renew the task lease.");
    }
    console.log("Coder task lease renewed by the owning worker.");
    return;
  }

  if (mode === "finish") {
    const taskId = process.env.FAM_CODER_TASK_ID || "";
    if (!taskId) return;
    const summary = await readTaskSummary(process.env.FAM_SUMMARY_PATH || "");
    const code = chooseResultCode(summary, process.env.FAM_MODEL_STEP_OUTCOME !== "failure");
    if (code === "model_generated") {
      const result = await bridgeRequest({
        url, token, body: { action: "advance", task_id: taskId, stage: code },
      });
      if (result?.ok !== true || result?.advanced !== true) {
        throw new Error("Bridge did not accept the generated model stage.");
      }
      console.log("Model output recorded as a proposal pending independent QA.");
      return;
    }
    const result = await bridgeRequest({
      url, token, body: { action: "finish", task_id: taskId, result_code: code },
    });
    if (result?.ok !== true || result?.saved !== true) {
      throw new Error("Bridge did not accept the task result.");
    }
    console.log("Coder task finished with allowlisted result code: " + code);
    return;
  }

  if (mode === "advance") {
    const taskId = process.env.FAM_CODER_TASK_ID || "";
    const stage = process.env.FAM_RESULT_STAGE || "";
    if (!taskId) return;
    const body = { action: "advance", task_id: taskId, stage };
    if (!body.stage) throw new Error("A lifecycle stage is required.");
    if (["pr_created", "owner_approved", "merged", "postmerge_verified"].includes(stage)) {
      body.pr_number = Number(process.env.FAM_PR_NUMBER);
    }
    const result = await bridgeRequest({ url, token, body });
    if (result?.ok !== true || result?.advanced !== true) {
      throw new Error("Bridge did not accept the task stage.");
    }
    console.log("Coder task lifecycle advanced to an allowlisted stage.");
    return;
  }

  throw new Error("Usage: node scripts/fam-agent-bridge.mjs claim|start|heartbeat|advance|finish");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
