import { createHash, timingSafeEqual } from 'node:crypto';

const WORKER_ID = 'fam-agent-qwen-coder-v1';
const MAX_BODY_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODER_TASK_KEYS = new Set(['audit_frontend_runtime', 'audit_client_resilience', 'audit_accessibility']);
const CODER_EVENT_CODES = new Set(['js_runtime', 'unhandled_rejection', 'listings_load_failed',
  'notifications_load_failed', 'database_request_failed', 'auth_backend_failed']);
const PAGE_AREAS = new Set(['auth', 'listings', 'notifications', 'database', 'other']);

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
  if (typeof queue?.claimSafeCoderTask !== 'function' || typeof queue?.finishSafeCoderTask !== 'function') {
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
      if (body.action === 'finish' && Object.keys(body).length === 4 && UUID.test(body.task_id || '')
          && UUID.test(body.claim_token || '')
          && ['model_completed', 'model_no_patch', 'model_failed', 'model_blocked'].includes(body.result_code)) {
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
