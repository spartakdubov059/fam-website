// Read-only bridge client for the FAM GitHub governance control tower.
// The server returns fixed aggregate counts only, never task payloads or user data.
const FIELDS = Object.freeze([
  "queued", "claimed", "in_progress", "failed_last_24h",
  "expired_leases", "oldest_queued_minutes",
]);

export const INSPECTOR_SIGNAL_CODES = Object.freeze([
  "ci_workflow_failure", "worker_queue_failure", "worker_expired_lease",
  "qwen_repeated_failure", "qwen_stuck_run", "synthetic_ci_workflow_failure",
]);

export function mapInspectorWarning(warning) {
  const mapping = {
    postmerge_workflow_failure: "ci_workflow_failure",
    supabase_queue_failures: "worker_queue_failure",
    supabase_expired_leases: "worker_expired_lease",
    repeated_failures: "qwen_repeated_failure",
    stuck_runs: "qwen_stuck_run",
  };
  if (!warning || warning.severity !== "high" || !Object.hasOwn(mapping, warning.code)) return null;
  return Object.freeze({
    signal_code: mapping[warning.code],
    occurrences: Number.isSafeInteger(warning.count) ? Math.max(1, Math.min(warning.count, 1000)) : 1,
  });
}

export function validateInspectorEnqueueResponse(body) {
  if (!body || typeof body !== "object" || body.ok !== true || typeof body.task_created !== "boolean" ||
      typeof body.reason !== "string" || !/^[a-z_]{1,48}$/.test(body.reason) ||
      (body.task_created && (typeof body.task_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.task_id)))) {
    throw new Error("Invalid INSPECTOR enqueue response");
  }
  return Object.freeze({ task_created: body.task_created, reason: body.reason });
}

export async function enqueueInspectorTask({ url, token, signalCode, eventId, occurrences, fetchImpl = fetch }) {
  if (typeof url !== "string" || !/^https:\/\//.test(url) || typeof token !== "string" || token.length < 12 ||
      !INSPECTOR_SIGNAL_CODES.includes(signalCode) || typeof eventId !== "string" ||
      !/^[a-z0-9:_-]{3,100}$/.test(eventId) || !Number.isSafeInteger(occurrences) || occurrences < 1 || occurrences > 1000) {
    throw new Error("Invalid allowlisted INSPECTOR task signal");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fam-agent-token": token },
    body: JSON.stringify({ action: "inspector_enqueue", signal_code: signalCode, event_id: eventId, occurrences }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) throw new Error("INSPECTOR enqueue bridge request failed");
  return validateInspectorEnqueueResponse(await response.json());
}

export function validateQueueHealthResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.ok !== true || !body.queue || typeof body.queue !== "object" ||
      Array.isArray(body.queue)) {
    throw new Error("Invalid FAM aggregate queue health response");
  }
  const keys = Object.keys(body.queue);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) {
    throw new Error("Unexpected fields in FAM aggregate queue health response");
  }
  const result = Object.create(null);
  for (const field of FIELDS) {
    const value = body.queue[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
      throw new Error("Invalid FAM aggregate queue counter");
    }
    result[field] = value;
  }
  return Object.freeze(result);
}

export async function fetchQueueHealth({ url, token, fetchImpl = fetch }) {
  if (typeof url !== "string" || !/^https:\/\//.test(url) ||
      typeof token !== "string" || token.length < 12) {
    throw new Error("FAM governance bridge credentials unavailable");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fam-agent-token": token,
    },
    body: JSON.stringify({ action: "health" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response || response.ok !== true) {
    throw new Error("FAM governance bridge health request failed");
  }
  return validateQueueHealthResponse(await response.json());
}

export function inspectQueueHealth(queue) {
  if (!queue) return [];
  const warnings = [];
  if (queue.failed_last_24h >= 3) {
    warnings.push({
      code: "supabase_queue_failures", severity: "high",
      count: queue.failed_last_24h,
      message: "Фоновая очередь Supabase: не менее трёх неудачных задач за 24 часа",
    });
  }
  if (queue.expired_leases > 0) {
    warnings.push({
      code: "supabase_expired_leases", severity: "high",
      count: queue.expired_leases,
      message: "В фоновой очереди Supabase есть задания с истёкшей арендой",
    });
  }
  if (queue.queued > 0 && queue.oldest_queued_minutes >= 180) {
    warnings.push({
      code: "supabase_oldest_queued", severity: "medium",
      count: queue.queued,
      message: "Ожидающее задание в Supabase находится в очереди более трёх часов",
    });
  }
  return warnings;
}

const METRIC_AGENTS = new Set(["orchestrator", "technical", "database", "moderation", "safety", "quality", "growth"]);
const METRIC_STATES = new Set(["queued", "claimed", "in_progress", "blocked", "completed", "failed", "cancelled"]);

export function validateAgentMetricsResponse(body) {
  if (!body || typeof body !== "object" || body.ok !== true || !Array.isArray(body.metrics) || body.metrics.length > 49) {
    throw new Error("Invalid aggregate agent metrics response");
  }
  return Object.freeze(body.metrics.map((row) => {
    if (!row || Object.keys(row).length !== 3 || !METRIC_AGENTS.has(row.agent_key) || !METRIC_STATES.has(row.status) ||
        !Number.isSafeInteger(row.count) || row.count < 0 || row.count > 10_000_000) {
      throw new Error("Invalid aggregate agent metrics row");
    }
    return Object.freeze({ agent_key: row.agent_key, status: row.status, count: row.count });
  }));
}

export async function fetchAgentMetrics({ url, token, fetchImpl = fetch }) {
  if (typeof url !== "string" || !/^https:\/\//.test(url) || typeof token !== "string" || token.length < 12) {
    throw new Error("FAM governance bridge credentials unavailable");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fam-agent-token": token },
    body: JSON.stringify({ action: "metrics" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) throw new Error("FAM aggregate metrics request failed");
  return validateAgentMetricsResponse(await response.json());
}

export function validateDevelopmentAdvisorResponse(body) {
  if (!body || typeof body !== "object" || body.ok !== true || !Array.isArray(body.snapshots) || body.snapshots.length > 14) {
    throw new Error("Invalid development advisor aggregate response");
  }
  return Object.freeze(body.snapshots.map((row) => {
    if (!row || Object.keys(row).length !== 5 ||
        typeof row.report_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.report_date) ||
        typeof row.generated_at !== "string" || !Number.isFinite(Date.parse(row.generated_at)) ||
        !["unknown", "none", "suppressed", "5_9", "10_24", "25_plus"].includes(row.active_listings_band) ||
        !["unknown", "none", "suppressed", "5_9", "10_24", "25_plus"].includes(row.new_listings_24h_band) ||
        !["none", "suppressed", "5_9", "10_24", "25_plus"].includes(row.pending_council_ideas_band)) {
      throw new Error("Invalid development advisor aggregate row");
    }
    return Object.freeze({
      report_date: row.report_date,
      generated_at: row.generated_at,
      active_listings_band: row.active_listings_band,
      new_listings_24h_band: row.new_listings_24h_band,
      pending_council_ideas_band: row.pending_council_ideas_band,
    });
  }));
}

export async function fetchDevelopmentAdvisorSnapshots({ url, token, fetchImpl = fetch }) {
  if (typeof url !== "string" || !/^https:\/\//.test(url) || typeof token !== "string" || token.length < 12) {
    throw new Error("FAM governance bridge credentials unavailable");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fam-agent-token": token },
    body: JSON.stringify({ action: "development_advisor_metrics" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) throw new Error("FAM development advisor aggregate request failed");
  return validateDevelopmentAdvisorResponse(await response.json());
}
