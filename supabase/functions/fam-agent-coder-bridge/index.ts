const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const WORKER_TOKEN = Deno.env.get("FAM_AGENT_WORKER_TOKEN") ?? "";

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
const MAX_BODY_BYTES = 65536;
const EVENT_CODES = new Set([
  "js_runtime", "unhandled_rejection", "supabase_sdk_unavailable",
  "listings_load_failed", "notifications_load_failed",
  "database_request_failed", "auth_backend_failed",
]);
const REPORT_FIELDS = new Set([
  "report_date", "generated_at", "sources", "supabase", "workflows_24h",
  "open_pull_requests", "role_statuses", "technical_analysis", "production_deployment", "public_site", "limitations", "markdown",
]);
const PAGE_AREAS = new Set(["auth", "listings", "notifications", "database", "other"]);

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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
    console.error("fam_agent_coder_bridge_rpc_failed", JSON.stringify({ rpc: name, status: response.status }));
    throw new Error("rpc_failed");
  }
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (req.headers.get("origin")) return json({ ok: false, error: "origin_not_allowed" }, 403);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !WORKER_TOKEN) {
    return json({ ok: false, error: "bridge_not_configured" }, 503);
  }
  if (!await sameSecret(req.headers.get("x-fam-agent-token") ?? "", WORKER_TOKEN)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, 413);
  }

  let body: any;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "request_too_large" }, 413);
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "invalid_body" }, 400);
  }

  try {
    if (body.action === "claim" && Object.keys(body).length === 1) {
      const tasks = await rpc("claim_fam_agent_coder_tasks", {
        p_worker_id: WORKER_ID,
        p_limit: 1,
        p_lease_seconds: 7200,
      });
      if (!Array.isArray(tasks) || tasks.length > 1) {
        return json({ ok: false, error: "invalid_queue_response" }, 502);
      }
      if (tasks.length === 0) return json({ ok: true, task: null });
      const task = tasks[0];
      if (
        typeof task?.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id) ||
        !["audit_frontend_runtime", "audit_client_resilience", "audit_accessibility"].includes(task.task_key) ||
        typeof task.event_code !== "string" ||
        !EVENT_CODES.has(task.event_code) ||
        typeof task.page_area !== "string" ||
        !PAGE_AREAS.has(task.page_area) ||
        !Number.isInteger(task.occurrences) ||
        task.occurrences < 0 ||
        task.occurrences > 1000
      ) {
        return json({ ok: false, error: "invalid_task_shape" }, 502);
      }
      return json({
        ok: true,
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
      body.action === "finish" &&
      Object.keys(body).length === 5 &&
      typeof body.task_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id) &&
      ["model_completed", "model_no_patch", "model_failed", "model_blocked"].includes(body.result_code) &&
      (body.pr_url === null || (
        typeof body.pr_url === "string" &&
        /^https:\/\/github\.com\/spartakdubov059\/fam-website\/pull\/[1-9][0-9]*$/.test(body.pr_url)
      )) &&
      (body.commit_sha === null || (
        typeof body.commit_sha === "string" && /^[0-9a-f]{40}$/i.test(body.commit_sha)
      )) &&
      ((body.result_code === "model_completed" && body.pr_url !== null && body.commit_sha !== null) ||
        (body.result_code !== "model_completed" && body.pr_url === null && body.commit_sha === null))
    ) {
      const saved = await rpc("finish_fam_agent_coder_task_with_pr", {
        p_task_id: body.task_id,
        p_worker_id: WORKER_ID,
        p_result_code: body.result_code,
        p_pr_url: body.pr_url,
        p_commit_sha: body.commit_sha,
      });
      return json({ ok: true, saved: saved === true });
    }

    if (body.action === "report" && Object.keys(body).length === 1) {
      const snapshot = await rpc("get_fam_agent_report_snapshot", {});
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        return json({ ok: false, error: "invalid_report_snapshot" }, 502);
      }
      return json({ ok: true, report: snapshot });
    }

    if (body.action === "save_report" && Object.keys(body).length === 3) {
      const reportDateValid = typeof body.report_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(body.report_date);
      const reportKeys = body.report && typeof body.report === "object" && !Array.isArray(body.report)
        ? Object.keys(body.report)
        : [];
      const reportValid = reportKeys.length === REPORT_FIELDS.size &&
        reportKeys.every((key) => REPORT_FIELDS.has(key)) &&
        body.report.report_date === body.report_date &&
        typeof body.report.markdown === "string" &&
        new TextEncoder().encode(JSON.stringify(body.report)).byteLength <= 65536;
      if (!reportDateValid || !reportValid) return json({ ok: false, error: "invalid_report" }, 400);
      const saved = await rpc("save_fam_agent_system_report", {
        p_report_date: body.report_date,
        p_report: body.report,
      });
      return json({ ok: true, saved: saved?.ok === true && saved.report_date === body.report_date });
    }

    return json({ ok: false, error: "invalid_action" }, 400);
  } catch {
    return json({ ok: false, error: "bridge_execution_failed" }, 500);
  }
});
