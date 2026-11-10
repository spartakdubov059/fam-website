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
      const queueHealthTask = task?.agent_key === "quality" &&
        task?.task_type === "queue_health_check" &&
        task?.approval_required === false;
      const dailyReportTask = task?.agent_key === "orchestrator" &&
        task?.task_type === "daily_report_digest" &&
        task?.approval_required === false;
      const systemHealthTask = task?.agent_key === "technical" &&
        task?.task_type === "system_health_check" &&
        task?.approval_required === false;
      const siteErrorTask = task?.agent_key === "technical" &&
        task?.task_type === "site_error_digest" &&
        task?.approval_required === false;
      const safeTask = queueHealthTask || dailyReportTask || systemHealthTask || siteErrorTask;

      let status: "completed" | "blocked" = "blocked";
      let summary = "Задача остановлена: её тип не входит в разрешённый список безопасного исполнителя.";

      const count = (value: unknown): number => {
        const parsedValue = Number(value);
        return Number.isSafeInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
      };

      if (queueHealthTask) {
        // This RPC returns aggregate queue counts only; it never reads task payloads or student content.
        const health = await rpc("get_fam_agent_queue_health", {});
        if (!health || typeof health !== "object" || Array.isArray(health)) {
          throw new Error("invalid_queue_health_response");
        }

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
      } else if (dailyReportTask) {
        // The RPC verifies this task is currently leased to this worker and returns an allowlisted
        // operational-only digest. Safety and account-related metrics are intentionally excluded.
        const digest = await rpc("get_fam_agent_task_daily_digest", {
          p_task_id: task.id,
          p_worker_id: WORKER_ID,
        });
        if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
          throw new Error("daily_report_digest_unavailable");
        }

        const reportDate = typeof digest.report_date === "string" ? digest.report_date : "дата не указана";
        status = "completed";
        summary = "Ежедневная операционная сводка FAM за " + reportDate + ". " +
          "Активных объявлений: " + count(digest.active_listings) + "; новых за сутки: " +
          count(digest.new_listings_24h) + "; предложений ждут решения: " + count(digest.pending_ideas) + "; " +
          "задач в очереди: " + count(digest.queued_tasks) + "; выполнено задач за сутки: " +
          count(digest.completed_tasks_24h) + "; заблокировано за сутки: " +
          count(digest.blocked_tasks_24h) + "; ошибок за сутки: " + count(digest.failed_tasks_24h) + ". " +
          "Использованы только агрегированные рабочие показатели; личные данные, сообщения, " +
          "объявления, сигналы безопасности и обращения по аккаунтам не читались.";
      } else if (systemHealthTask) {
        // The RPC exposes fixed infrastructure metadata and aggregate counters only.
        // It verifies that this exact task is leased to the current worker.
        const health = await rpc("get_fam_agent_task_system_health", {
          p_task_id: task.id,
          p_worker_id: WORKER_ID,
        });
        if (!health || typeof health !== "object" || Array.isArray(health)) {
          throw new Error("system_health_result_unavailable");
        }

        const extensions = health.extensions && typeof health.extensions === "object"
          ? health.extensions
          : {};
        const jobs = Array.isArray(health.scheduled_jobs) ? health.scheduled_jobs : [];
        const permissions = health.rpc_permissions && typeof health.rpc_permissions === "object"
          ? health.rpc_permissions
          : {};
        const queue = health.queue && typeof health.queue === "object" ? health.queue : {};
        const extensionChecks = [extensions.pg_cron, extensions.pg_net];
        const installedExtensions = extensionChecks.filter((item: any) => item?.installed === true).length;
        const activeSchedules = jobs.filter((item: any) =>
          item?.active === true && item?.schedule_matches === true
        ).length;
        const rpcChecks = Object.values(permissions).filter((value) => value === true).length;
        const rpcTotal = Object.keys(permissions).length;
        const overallOk = health.overall_ok === true;

        const queued = count(queue.queued);
        const expiredLeases = count(queue.expired_leases);
        const failedLast24h = count(queue.failed_last_24h);
        const scheduleIssues = jobs
          .filter((item: any) => item?.active !== true || item?.schedule_matches !== true)
          .map((item: any) => String(item?.job ?? "неизвестное расписание"))
          .slice(0, 4);

        status = "completed";
        summary = "Техническая проверка FAM: " +
          (overallOk ? "критические проверки пройдены. " : "обнаружены технические замечания. ") +
          "Расширения установлены: " + installedExtensions + "/2; расписания активны и соответствуют настройкам: " +
          activeSchedules + "/" + jobs.length + "; права RPC: " + rpcChecks + "/" + rpcTotal + "; " +
          "задач в очереди: " + queued + "; просроченных блокировок: " + expiredLeases +
          "; ошибок задач за сутки: " + failedLast24h + ". " +
          (scheduleIssues.length ? "Проблемные расписания: " + scheduleIssues.join(", ") + ". " : "") +
          "Проверялись только служебные настройки и агрегаты; пользовательские данные не читались.";
      } else if (siteErrorTask) {
        // Read only fixed, aggregated event counters; no text, identifiers, URLs, or stack traces are stored.
        const digest = await rpc("get_fam_agent_task_site_error_digest", {
          p_task_id: task.id,
          p_worker_id: WORKER_ID,
        });
        if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
          throw new Error("site_error_digest_unavailable");
        }

        const total24h = count(digest.total_events_24h);
        const lastHour = count(digest.events_last_hour);
        const events = Array.isArray(digest.events) ? digest.events.slice(0, 6) : [];
        const details = events.map((item: any) =>
          String(item?.event_code ?? "unknown") + "/" +
          String(item?.page_area ?? "unknown") + ": " +
          count(item?.occurrences)
        ).join("; ");

        status = "completed";
        summary = "Проверка клиентских ошибок FAM: за 24 часа зарегистрировано " +
          total24h + " событий, за последний час — " + lastHour + ". " +
          (details ? "Категории: " + details + ". " : "") +
          "Собраны только агрегированные коды ошибок и разделы; личные данные не собирались.";
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
