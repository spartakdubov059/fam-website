const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const WORKER_TOKEN = Deno.env.get("FAM_AGENT_WORKER_TOKEN") ?? "";
const INTEGRATOR_TOKEN = Deno.env.get("FAM_AGENT_INTEGRATOR_TOKEN") ?? "";

function readDefaultKey(variable: string): string {
  const raw = Deno.env.get(variable) ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    // Legacy service-role JWT.
  }
  return raw;
}

const SUPABASE_SECRET_KEY =
  readDefaultKey("SUPABASE_SECRET_KEYS") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SECRET_KEY") ||
  "";
const LEGACY_SECRET_IS_JWT = SUPABASE_SECRET_KEY.startsWith("eyJ");
const WORKER_ID = "fam-agent-qwen-coder-v1";
const INTEGRATOR_ID = "fam-agent-integrator-v1";
const MAX_BODY_BYTES = 2048;
const EVENT_CODES = new Set([
  "js_runtime", "unhandled_rejection", "supabase_sdk_unavailable",
  "listings_load_failed", "notifications_load_failed",
  "database_request_failed", "auth_backend_failed",
  "ci_workflow_failure", "worker_queue_failure", "worker_expired_lease",
  "qwen_repeated_failure", "qwen_stuck_run", "synthetic_ci_workflow_failure",
]);
const PAGE_AREAS = new Set(["auth", "listings", "notifications", "database", "other", "agent_infrastructure"]);
const INSPECTOR_SIGNALS = new Set([
  "ci_workflow_failure", "worker_queue_failure", "worker_expired_lease",
  "qwen_repeated_failure", "qwen_stuck_run", "synthetic_ci_workflow_failure",
]);

function json(body: Record<string, unknown>, status = 200, diagnosticId = crypto.randomUUID()): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-FAM-Diagnostic-Id": diagnosticId,
    },
  });
}

async function sameSecret(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
  };
  if (LEGACY_SECRET_IS_JWT) headers.Authorization = "Bearer " + SUPABASE_SECRET_KEY;
  return headers;
}

async function rpc(name: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let data: any = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  if (!response.ok) {
    const error = new Error("rpc_failed");
    Object.assign(error, { code: "rpc_http_error", httpStatus: response.status, rpc: name });
    throw error;
  }
  return data;
}

Deno.serve(async (req: Request) => {
  const diagnosticId = crypto.randomUUID();
  if (req.method !== "POST") return json({ ok: false, error_code: "method_not_allowed", stage: "request" , diagnostic_id: diagnosticId }, 405, diagnosticId);
  if (req.headers.get("origin")) return json({ ok: false, error_code: "origin_not_allowed", stage: "request", diagnostic_id: diagnosticId }, 403, diagnosticId);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return json({ ok: false, error_code: "bridge_not_configured", stage: "configuration", diagnostic_id: diagnosticId }, 503, diagnosticId);
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error_code: "request_too_large", stage: "request_validation", diagnostic_id: diagnosticId }, 413, diagnosticId);
  }

  let body: any;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error_code: "request_too_large", stage: "request_validation", diagnostic_id: diagnosticId }, 413, diagnosticId);
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ ok: false, error_code: "invalid_json", stage: "request_parse", diagnostic_id: diagnosticId }, 400, diagnosticId);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error_code: "invalid_body", stage: "request_validation", diagnostic_id: diagnosticId }, 400, diagnosticId);
  }
  const expectedToken = body.action === "resolve" ? INTEGRATOR_TOKEN : WORKER_TOKEN;
  if (!expectedToken || (body.action === "resolve" && expectedToken === WORKER_TOKEN) ||
      !await sameSecret(req.headers.get("x-fam-agent-token") ?? "", expectedToken)) {
    return json({ ok: false, error_code: "unauthorized", stage: "authentication", diagnostic_id: diagnosticId }, 401, diagnosticId);
  }

  try {
    if (
      body.action === "inspector_enqueue" && Object.keys(body).length === 4 &&
      INSPECTOR_SIGNALS.has(body.signal_code) &&
      typeof body.event_id === "string" && /^[a-z0-9:_-]{3,100}$/.test(body.event_id) &&
      Number.isSafeInteger(body.occurrences) && body.occurrences >= 1 && body.occurrences <= 1000
    ) {
      const result = await rpc("enqueue_fam_agent_inspector_task", {
        p_signal_code: body.signal_code,
        p_event_id: body.event_id,
        p_occurrences: body.occurrences,
      });
      if (!result || typeof result !== "object" || result.ok !== true || typeof result.task_created !== "boolean") {
        return json({ ok: false, error_code: "invalid_inspector_enqueue_result", stage: "rpc_validation", diagnostic_id: diagnosticId }, 502, diagnosticId);
      }
      return json({
        ok: true,
        task_created: result.task_created,
        reason: typeof result.reason === "string" ? result.reason : "unknown",
        ...(typeof result.task_id === "string" ? { task_id: result.task_id } : {}),
        diagnostic_id: diagnosticId,
      }, 200, diagnosticId);
    }

    // Read-only control tower link: no task IDs, descriptions or user information.
    if (body.action === "health" && Object.keys(body).length === 1) {
      const stats = await rpc("get_fam_agent_queue_health", {});
      const fields = [
        "queued", "claimed", "in_progress", "failed_last_24h",
        "expired_leases", "oldest_queued_minutes",
      ] as const;
      if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
        return json({ ok: false, error: "invalid_queue_health" }, 502);
      }
      const safe: Record<string, number> = {};
      for (const key of fields) {
        const value = stats[key];
        if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
          return json({ ok: false, error: "invalid_queue_health" }, 502);
        }
        safe[key] = value;
      }
      return json({ ok: true, queue: safe, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    if (body.action === "metrics" && Object.keys(body).length === 1) {
      const metrics = await rpc("get_fam_agent_task_metrics", {});
      const allowedAgents = new Set(["orchestrator", "technical", "database", "moderation", "safety", "quality", "growth"]);
      const allowedStatuses = new Set(["queued", "claimed", "in_progress", "blocked", "completed", "failed", "cancelled"]);
      if (!Array.isArray(metrics) || metrics.length > 49 || metrics.some((row) =>
        !row || !allowedAgents.has(row.agent_key) || !allowedStatuses.has(row.status) ||
        !Number.isSafeInteger(Number(row.count)) || Number(row.count) < 0 || Number(row.count) > 10_000_000
      )) return json({ ok: false, error: "invalid_task_metrics" }, 502);
      const safe = metrics.map((row) => ({ agent_key: row.agent_key, status: row.status, count: Number(row.count) }));
      return json({ ok: true, metrics: safe, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    if (body.action === "claim" && Object.keys(body).length === 1) {
      const tasks = await rpc("claim_fam_agent_coder_tasks", {
        p_worker_id: WORKER_ID,
        p_limit: 1,
        p_lease_seconds: 7200,
      });
      if (!Array.isArray(tasks) || tasks.length > 1) {
        return json({ ok: false, error: "invalid_queue_response" }, 502);
      }
      if (tasks.length === 0) return json({ ok: true, task: null, diagnostic_id: diagnosticId }, 200, diagnosticId);
      const task = tasks[0];
      if (
        typeof task?.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id) ||
        !["audit_frontend_runtime", "audit_client_resilience", "audit_accessibility", "audit_agent_infrastructure"].includes(task.task_key) ||
        !EVENT_CODES.has(task.event_code) ||
        !PAGE_AREAS.has(task.page_area) ||
        !Number.isInteger(task.occurrences) ||
        task.occurrences < 0 ||
        task.occurrences > 1000 ||
        (task.task_key === "audit_agent_infrastructure" && (task.page_area !== "agent_infrastructure" || !INSPECTOR_SIGNALS.has(task.event_code) || task.occurrences < 1)) ||
        (task.task_key !== "audit_agent_infrastructure" && task.page_area === "agent_infrastructure")
      ) {
        return json({ ok: false, error: "invalid_task_shape" }, 502);
      }
      return json({
        ok: true,
        diagnostic_id: diagnosticId,
        task: {
          id: task.id,
          task_key: task.task_key,
          event_code: task.event_code,
          page_area: task.page_area,
          occurrences: task.occurrences,
        },
      });
    }

    if (
      body.action === "start" &&
      Object.keys(body).length === 2 &&
      typeof body.task_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id)
    ) {
      const started = await rpc("start_fam_agent_coder_task", {
        p_task_id: body.task_id,
        p_worker_id: WORKER_ID,
        p_lease_seconds: 1800,
      });
      return json({ ok: true, started: started === true, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    if (
      body.action === "heartbeat" &&
      Object.keys(body).length === 2 &&
      typeof body.task_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id)
    ) {
      const renewed = await rpc("heartbeat_fam_agent_coder_task", {
        p_task_id: body.task_id,
        p_worker_id: WORKER_ID,
        p_lease_seconds: 1800,
      });
      return json({ ok: true, renewed: renewed === true, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    if (
      body.action === "advance" &&
      (Object.keys(body).length === 3 || Object.keys(body).length === 4) &&
      typeof body.task_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id) &&
      ["model_generated", "qa_passed", "pr_created", "qa_failed", "qa_unavailable", "model_no_patch", "model_failed", "model_blocked"].includes(body.stage) &&
      ((body.stage === "pr_created" && Number.isSafeInteger(body.pr_number) && body.pr_number > 0 && body.pr_number < 100_000_000) ||
       (body.stage !== "pr_created" && body.pr_number === undefined))
    ) {
      const advanced = await rpc("advance_fam_agent_coder_task", {
        p_task_id: body.task_id,
        p_worker_id: WORKER_ID,
        p_stage: body.stage,
        p_pr_number: body.pr_number ?? null,
      });
      return json({ ok: true, advanced: advanced === true, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    if (
      body.action === "resolve" &&
      typeof body.task_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id) &&
      ["owner_approved", "merged", "postmerge_verified", "postmerge_failed", "pr_closed_unmerged"].includes(body.stage) &&
      Number.isSafeInteger(body.pr_number) && body.pr_number > 0 && body.pr_number < 100_000_000 &&
      typeof body.head_sha === "string" && /^[0-9a-f]{40}$/i.test(body.head_sha) &&
      ((["merged", "postmerge_verified", "postmerge_failed"].includes(body.stage) &&
        typeof body.merge_commit_sha === "string" && /^[0-9a-f]{40}$/i.test(body.merge_commit_sha)) ||
       (!["merged", "postmerge_verified", "postmerge_failed"].includes(body.stage) &&
        body.merge_commit_sha === undefined))
    ) {
      const keyCount = Object.keys(body).length;
      if (keyCount !== (body.merge_commit_sha === undefined ? 5 : 6)) {
        return json({ ok: false, error_code: "invalid_action", stage: "action_validation", diagnostic_id: diagnosticId }, 400, diagnosticId);
      }
      const resolved = await rpc("resolve_fam_agent_coder_lifecycle", {
        p_task_id: body.task_id,
        p_worker_id: INTEGRATOR_ID,
        p_stage: body.stage,
        p_pr_number: body.pr_number,
        p_head_sha: body.head_sha,
        p_merge_commit_sha: body.merge_commit_sha ?? null,
      });
      return json({ ok: true, resolved: resolved === true, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    if (
      body.action === "finish" &&
      Object.keys(body).length === 3 &&
      typeof body.task_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id) &&
      ["model_no_patch", "model_failed", "model_blocked"].includes(body.result_code)
    ) {
      const saved = await rpc("finish_fam_agent_coder_task", {
        p_task_id: body.task_id,
        p_worker_id: WORKER_ID,
        p_result_code: body.result_code,
      });
      return json({ ok: true, saved: saved === true, diagnostic_id: diagnosticId }, 200, diagnosticId);
    }

    console.warn("fam_agent_coder_bridge_rejected", JSON.stringify({ diagnostic_id: diagnosticId, stage: "action_validation", error_code: "invalid_action", action: typeof body.action === "string" ? body.action : "invalid", field_count: Object.keys(body).length }));
    return json({ ok: false, error_code: "invalid_action", stage: "action_validation", diagnostic_id: diagnosticId }, 400, diagnosticId);
  } catch (error) {
    const safeError = error as { code?: string; httpStatus?: number; rpc?: string };
    const errorCode = safeError?.code === "rpc_http_error" ? "rpc_http_error" : "bridge_execution_failed";
    const stage = safeError?.rpc === "finish_fam_agent_coder_task" ? "finish_rpc" : "rpc_or_action";
    console.error("fam_agent_coder_bridge_failed", JSON.stringify({ diagnostic_id: diagnosticId, stage, error_code: errorCode, http_status: Number.isInteger(safeError?.httpStatus) ? safeError.httpStatus : null, rpc: typeof safeError?.rpc === "string" ? safeError.rpc : null }));
    return json({ ok: false, error_code: errorCode, stage, diagnostic_id: diagnosticId }, 500, diagnosticId);
  }
});
