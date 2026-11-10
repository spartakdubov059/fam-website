const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const WORKER_TOKEN = Deno.env.get("FAM_AGENT_WORKER_TOKEN") ?? "";

function readDefaultKey(variable: string): string {
  const raw = Deno.env.get(variable) ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    // Legacy Supabase service-role keys are plain strings.
  }
  return raw;
}

const SUPABASE_SECRET_KEY =
  readDefaultKey("SUPABASE_SECRET_KEYS") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SECRET_KEY") ||
  "";
const LEGACY_SECRET_IS_JWT = SUPABASE_SECRET_KEY.startsWith("eyJ");
const WORKER_ID = "fam-agent-worker-v1";

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
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
    "apikey": SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
  };
  // New sb_secret keys are not JWTs; legacy service-role keys are.
  if (LEGACY_SECRET_IS_JWT) headers["Authorization"] = "Bearer " + SUPABASE_SECRET_KEY;
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
    console.error("fam_agent_worker_rpc_failed", JSON.stringify({ rpc: name, status: response.status }));
    throw new Error("rpc_failed");
  }
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (req.headers.get("origin")) return json({ ok: false, error: "origin_not_allowed" }, 403);

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !WORKER_TOKEN) {
    return json({ ok: false, error: "worker_not_configured" }, 503);
  }

  const suppliedToken = req.headers.get("x-fam-agent-token") ?? "";
  if (!await sameSecret(suppliedToken, WORKER_TOKEN)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let limit = 3;
  try {
    const body = await req.json();
    if (body && Number.isInteger(body.limit)) limit = Math.min(5, Math.max(1, body.limit));
  } catch {
    // An empty body is valid; the worker uses the safe default batch size.
  }

  try {
    const tasks = await rpc("claim_fam_agent_tasks", {
      p_worker_id: WORKER_ID,
      p_limit: limit,
      p_lease_seconds: 120,
    });

    if (!Array.isArray(tasks)) return json({ ok: false, error: "invalid_queue_response" }, 502);

    let completed = 0;
    let blocked = 0;
    for (const task of tasks) {
      const safeTask = task?.agent_key === "quality" &&
        task?.task_type === "queue_health_check" &&
        task?.approval_required === false;

      let status: "completed" | "blocked" = "blocked";
      let summary = "Задача остановлена: её тип не входит в разрешённый список безопасного исполнителя.";

      if (safeTask) {
        // This RPC returns aggregate queue counts only; it never reads task payloads or student content.
        const health = await rpc("get_fam_agent_queue_health", {});
        if (!health || typeof health !== "object" || Array.isArray(health)) {
          throw new Error("invalid_queue_health_response");
        }

        const count = (value: unknown): number => {
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
        };

        const queued = count(health.queued);
        const claimed = count(health.claimed);
        const inProgress = count(health.in_progress);
        const failedLast24h = count(health.failed_last_24h);
        const expiredLeases = count(health.expired_leases);
        const oldestQueuedMinutes = count(health.oldest_queued_minutes);

        status = "completed";
        summary = "Аудит очереди завершён. " +
          "Ожидают: " + queued + "; захвачены: " + claimed + "; выполняются: " + inProgress + "; " +
          "ошибки за 24 часа: " + failedLast24h + "; просроченные аренды: " + expiredLeases + "; " +
          "возраст старейшей ожидающей задачи, минут: " + oldestQueuedMinutes + ". " +
          "Содержимое задач и личные данные не читались.";
      }

      const saved = await rpc("finish_fam_agent_task", {
        p_task_id: task.id,
        p_worker_id: WORKER_ID,
        p_status: status,
        p_summary: summary,
      });

      if (saved === true) {
        if (status === "completed") completed++;
        else blocked++;
      }
    }

    return json({ ok: true, claimed: tasks.length, completed, blocked });
  } catch {
    return json({ ok: false, error: "worker_execution_failed" }, 500);
  }
});
