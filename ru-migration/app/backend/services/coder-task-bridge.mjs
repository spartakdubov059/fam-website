import { createHash, timingSafeEqual } from 'node:crypto';

const WORKER_ID = 'fam-agent-qwen-coder-v1';
const MAX_BODY_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODER_TASK_KEYS = new Set(['audit_frontend_runtime', 'audit_client_resilience', 'audit_accessibility']);
const CODER_EVENT_CODES = new Set(['js_runtime', 'unhandled_rejection', 'listings_load_failed',
  'notifications_load_failed', 'database_request_failed', 'auth_backend_failed']);
const PAGE_AREAS = new Set(['auth', 'listings', 'notifications', 'database', 'other']);
const AGENT_KEYS = new Set(['orchestrator', 'technical', 'database', 'moderation', 'safety', 'quality', 'growth']);
const TASK_STATUSES = new Set(['queued', 'claimed', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']);
const MAX_METRIC_ROWS = AGENT_KEYS.size * TASK_STATUSES.size;
const MAX_METRIC_COUNT = 10_000_000;

function matchesSecret(provided, expected) {
  if (typeof provided !== 'string' || !provided || typeof expected !== 'string' || Buffer.byteLength(expected) < 32) return false;
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { error: 'request_too_large', status: 413 };
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { error: 'request_too_large', status: 413 };
    chunks.push(chunk);
  }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { error: 'invalid_json', status: 400 }; }
}

export function createCoderTaskBridge({ queue, token } = {}) {
  if (typeof queue?.claimSafeCoderTask !== 'function' || typeof queue?.finishSafeCoderTask !== 'function'
      || typeof queue?.getAgentTaskQueueHealth !== 'function'
      || typeof queue?.startSafeCoderTask !== 'function'
      || typeof queue?.heartbeatSafeCoderTask !== 'function'
      || typeof queue?.advanceSafeCoderTask !== 'function') {
    throw new TypeError('coder task queue is required');
  }
  return async function handleCoderTaskBridge(req) {
    const json = (status, body) => ({ status, body });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    if (req.headers.origin) return json(403, { ok: false, error: 'origin_not_allowed' });
    if (typeof token !== 'string' || Buffer.byteLength(token) < 32) return json(503, { ok: false, error: 'bridge_not_configured' });
    if (!matchesSecret(req.headers['x-fam-agent-token'], token)) return json(401, { ok: false, error: 'unauthorized' });
    const parsed = await readBody(req);
    if (parsed.error) return json(parsed.status, { ok: false, error: parsed.error });
    const body = parsed.value;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'invalid_body' });
    try {
      if (body.action === 'health' && Object.keys(body).length === 1) {
        const queueHealth = await queue.getAgentTaskQueueHealth();
        const fields = ['queued', 'claimed', 'in_progress', 'failed_last_24h', 'expired_leases', 'oldest_queued_minutes'];
        if (!queueHealth || typeof queueHealth !== 'object' || Array.isArray(queueHealth)
            || fields.some(field => !Number.isSafeInteger(queueHealth[field]) || queueHealth[field] < 0 || queueHealth[field] > 10_000_000)) {
          return json(502, { ok: false, error: 'invalid_queue_health' });
        }
        return json(200, { ok: true, queue: Object.fromEntries(fields.map(field => [field, queueHealth[field]])) });
      }
      if (body.action === 'metrics' && Object.keys(body).length === 1) {
        if (typeof queue.getAgentTaskMetrics !== 'function') return json(503, { ok: false, error: 'metrics_unavailable' });
        const metrics = await queue.getAgentTaskMetrics();
        if (!Array.isArray(metrics) || metrics.length > MAX_METRIC_ROWS || metrics.some(row =>
          !row || typeof row !== 'object' || Array.isArray(row)
          || Object.keys(row).sort().join(',') !== 'agent_key,count,status'
          || !AGENT_KEYS.has(row.agent_key) || !TASK_STATUSES.has(row.status)
          || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > MAX_METRIC_COUNT
        )) return json(502, { ok: false, error: 'invalid_task_metrics' });
        return json(200, { ok: true, metrics: metrics.map(({ agent_key, status, count }) => ({ agent_key, status, count })) });
      }
      if (body.action === 'claim' && Object.keys(body).length === 1) {
        const task = await queue.claimSafeCoderTask({ workerId: WORKER_ID, leaseSeconds: 7200 });
        if (!task) return json(200, { ok: true, task: null });
        if (!UUID.test(task.id || '') || !UUID.test(task.claim_token || '')
            || !CODER_TASK_KEYS.has(task.task_key)
            || !CODER_EVENT_CODES.has(task.event_code)
            || !PAGE_AREAS.has(task.page_area)
            || !Number.isInteger(task.occurrences) || task.occurrences < 0 || task.occurrences > 1000) {
          return json(502, { ok: false, error: 'invalid_task_shape' });
        }
        return json(200, { ok: true, task: { id: task.id, task_key: task.task_key,
          event_code: task.event_code, page_area: task.page_area, occurrences: task.occurrences,
          claim_token: task.claim_token } });
      }
      if (['start', 'heartbeat'].includes(body.action) && Object.keys(body).length === 3
          && UUID.test(body.task_id || '') && UUID.test(body.claim_token || '')) {
        const input = { id: body.task_id, claimToken: body.claim_token, workerId: WORKER_ID };
        const accepted = body.action === 'start'
          ? await queue.startSafeCoderTask(input)
          : await queue.heartbeatSafeCoderTask(input);
        return json(200, body.action === 'start' ? { ok: true, started: accepted === true }
          : { ok: true, renewed: accepted === true });
      }
      if (body.action === 'advance' && [4, 5].includes(Object.keys(body).length)
          && UUID.test(body.task_id || '') && UUID.test(body.claim_token || '')
          && ['model_generated', 'qa_passed', 'pr_created', 'qa_failed', 'model_no_patch', 'model_failed', 'model_blocked'].includes(body.stage)
          && ((body.stage === 'pr_created' && Number.isSafeInteger(body.pr_number) && body.pr_number > 0 && body.pr_number < 100_000_000)
            || (body.stage !== 'pr_created' && body.pr_number === undefined))) {
        const advanced = await queue.advanceSafeCoderTask({ id: body.task_id, claimToken: body.claim_token,
          workerId: WORKER_ID, stage: body.stage, prNumber: body.pr_number });
        return json(200, { ok: true, advanced: advanced === true });
      }
      if (body.action === 'finish' && Object.keys(body).length === 4 && UUID.test(body.task_id || '')
          && UUID.test(body.claim_token || '')
          && ['model_no_patch', 'model_failed', 'model_blocked'].includes(body.result_code)) {
        const saved = await queue.finishSafeCoderTask({ id: body.task_id, workerId: WORKER_ID,
          claimToken: body.claim_token, resultCode: body.result_code });
        return json(200, { ok: true, saved: saved === true });
      }
      return json(400, { ok: false, error: 'invalid_action' });
    } catch {
      return json(500, { ok: false, error: 'bridge_execution_failed' });
    }
  };
}
