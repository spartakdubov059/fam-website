import { validateSchoolAnnouncement, validateSchoolPoll } from '../policies/pulse-policy.mjs';

const POLL_ID = /^\/api\/v1\/pulse\/polls\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/votes$/i;
const STAFF_ROLES = new Set(['school_admin', 'council_member']);

async function readJson(req, limit = 8 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) return { error: 'request_too_large' };
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'invalid_json' };
  } catch { return { error: 'invalid_json' }; }
}

function failure(code) {
  const statuses = {
    trusted_school_role_required: 403, school_profile_required: 403,
    poll_unavailable: 404, poll_closed: 409, already_voted: 409,
    daily_announcement_limit: 429, daily_poll_limit: 429,
    invalid_choice: 400, invalid_announcement: 400, invalid_poll: 400,
    invalid_poll_options: 400, duplicate_poll_options: 400, invalid_poll_close: 400,
  };
  return { status: statuses[code] || 503, body: { ok: false, error: code || 'pulse_unavailable' } };
}

export function createSchoolPulseApi({ authenticate = async () => null, resolveActor = async () => null, repository, now = Date.now } = {}) {
  return async function handle(req) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const vote = pathname.match(POLL_ID);
    const allowed = (req.method === 'GET' && pathname === '/api/v1/pulse')
      || (req.method === 'POST' && ['/api/v1/pulse/announcements', '/api/v1/pulse/polls'].includes(pathname))
      || (req.method === 'POST' && vote);
    if (!allowed) return { status: 404, body: { ok: false, error: 'not_found' } };
    let identity;
    try { identity = await authenticate(req); } catch { identity = null; }
    if (!identity) return { status: 401, body: { ok: false, error: 'unauthorized' } };
    let actor;
    try { actor = await resolveActor(identity); } catch { actor = null; }
    if (!actor?.id || !actor.school_id) return { status: 403, body: { ok: false, error: 'school_profile_required' } };

    if (req.method === 'GET') {
      if (typeof repository?.listSchoolPulse !== 'function') return failure('pulse_unavailable');
      try { return { status: 200, body: { ok: true, ...await repository.listSchoolPulse(actor.school_id, actor.id) } }; }
      catch { return failure('database_unavailable'); }
    }
    if (vote) {
      const parsed = await readJson(req, 1024);
      if (parsed.error) return { status: parsed.error === 'request_too_large' ? 413 : 400, body: { ok: false, error: parsed.error } };
      const choiceIndex = parsed.value.choice_index;
      if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) return failure('invalid_choice');
      if (typeof repository?.voteSchoolPoll !== 'function') return failure('pulse_unavailable');
      try {
        const result = await repository.voteSchoolPoll({ pollId: vote[1], schoolId: actor.school_id, userId: actor.id, choiceIndex });
        return result?.ok ? { status: 201, body: { ok: true, voted: true } } : failure(result?.code);
      } catch (error) {
        if (error?.code === 'ALREADY_EXISTS') return failure('already_voted');
        return failure('database_unavailable');
      }
    }

    if (!STAFF_ROLES.has(actor.role)) return failure('trusted_school_role_required');
    const parsed = await readJson(req);
    if (parsed.error) return { status: parsed.error === 'request_too_large' ? 413 : 400, body: { ok: false, error: parsed.error } };
    if (pathname === '/api/v1/pulse/announcements') {
      const validated = validateSchoolAnnouncement(parsed.value, now());
      if (!validated.ok) return failure(validated.code);
      if (typeof repository?.publishSchoolAnnouncement !== 'function') return failure('pulse_unavailable');
      try {
        const result = await repository.publishSchoolAnnouncement({
          schoolId: actor.school_id, authorId: actor.id, title: validated.announcement.title,
          body: validated.announcement.body, kind: validated.announcement.kind,
          eventStartsAt: validated.announcement.event_starts_at,
        });
        return result?.ok ? { status: 201, body: { ok: true, id: result.id } } : failure(result?.code);
      } catch { return failure('database_unavailable'); }
    }
    const validated = validateSchoolPoll(parsed.value, now());
    if (!validated.ok) return failure(validated.code);
    if (typeof repository?.publishSchoolPoll !== 'function') return failure('pulse_unavailable');
    try {
      const result = await repository.publishSchoolPoll({
        schoolId: actor.school_id, authorId: actor.id, question: validated.poll.question,
        options: validated.poll.options, closesAt: validated.poll.closes_at,
      });
      return result?.ok ? { status: 201, body: { ok: true, id: result.id } } : failure(result?.code);
    } catch { return failure('database_unavailable'); }
  };
}
