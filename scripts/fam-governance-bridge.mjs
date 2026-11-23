// Read-only bridge client for the FAM GitHub governance control tower.
// The server returns fixed aggregate counts only, never task payloads or user data.
const FIELDS = Object.freeze([
  "queued", "claimed", "in_progress", "failed_last_24h",
  "expired_leases", "oldest_queued_minutes",
]);

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
