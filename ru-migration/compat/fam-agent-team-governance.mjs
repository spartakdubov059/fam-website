import { FAM_AGENT_TEAM, validateAgentTeamTask } from '../app/backend/policies/agent-team.mjs';

const APPROVED_AGENT_NAMES = Object.freeze({
  coordinator: 'Босс',
  security_reviewer: 'Проверяющий',
  legal_advisor: 'Юрист',
  developer: 'Разработчик (Qwen)',
  tester: 'Испытатель',
  integrator: 'Связной',
  analyst: 'Советник',
  inspector: 'Надзиратель',
});

const withDisplayName = role => Object.freeze({
  ...role,
  display_name: APPROVED_AGENT_NAMES[role.key] || role.title,
});

// Keep technical keys stable; display names are a separate compatibility layer.
export const RU_AGENT_TEAM = Object.freeze([
  ...FAM_AGENT_TEAM.map(withDisplayName),
  withDisplayName({ key: 'inspector', title: 'INSPECTOR', allows_model: false, permissions: Object.freeze(['aggregate_diagnostics', 'enqueue_allowlisted_task']) }),
  withDisplayName({ key: 'qa', title: 'QA', allows_model: false, permissions: Object.freeze(['independent_validation']) }),
  withDisplayName({ key: 'arbiter', title: 'ARBITER', allows_model: false, permissions: Object.freeze(['detect_file_conflicts']) }),
  withDisplayName({ key: 'integrator', title: 'INTEGRATOR', allows_model: false, permissions: Object.freeze(['coordinate_review_order']) }),
  withDisplayName({ key: 'recruiter', title: 'RECRUITER', allows_model: false, permissions: Object.freeze(['propose_human_review']) }),
  withDisplayName({
    key: 'legal_advisor', title: 'LEGAL', allows_model: false,
    permissions: Object.freeze(['prepare_scoped_guidance', 'propose_alternatives', 'check_public_sources', 'append_decision_digest', 'audit_agent_scope']),
  }),
]);

const SCOPES = new Set(['FAM_CURRENT', 'FAM_RU', 'SHARED']);
const LEGAL_IMPACTS = new Set(['none', 'possible', 'confirmed', 'unknown']);
const OFFICIAL_SOURCE_HOSTS = new Set([
  'publication.pravo.gov.ru', 'pravo.gov.ru', 'government.ru', 'rkn.gov.ru',
  'minjust.gov.ru', 'fstec.ru', 'roskomnadzor.gov.ru',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/**
 * Offline process check only. It validates ordering and scope binding, not the
 * accuracy of legal advice, the authenticity of sources, or release authority.
 */
export function evaluateLegalConsultation(input, { now = Date.now() } = {}) {
  const fail = code => ({ ok: false, code, status: 'blocked', live_cutover_authorized: false, permission_escalation: false });
  if (!exactKeys(input, ['scope', 'revision_sha256', 'impact', 'classifier', 'guidance'])
      || !SCOPES.has(input.scope) || !SHA256.test(input.revision_sha256 || '')
      || !LEGAL_IMPACTS.has(input.impact) || !['arbiter', 'operator'].includes(input.classifier)
      || !Number.isSafeInteger(now)) return fail('INVALID_LEGAL_CONSULTATION_SCOPE');

  if (input.impact === 'none') {
    if (input.guidance !== null || input.classifier !== 'arbiter') return fail('LEGAL_SCOPE_REQUIRES_REVIEW');
    return { ok: true, code: 'LEGAL_CONSULTATION_NOT_REQUIRED', status: 'not_required',
      scope: input.scope, revision_sha256: input.revision_sha256,
      live_cutover_authorized: false, permission_escalation: false };
  }

  const guidance = input.guidance;
  if (!exactKeys(guidance, ['role', 'scope', 'revision_sha256', 'advice_status', 'human_review',
    'requirement_codes', 'alternative_codes', 'source_checks', 'decision_digest', 'synthetic_only'])
      || guidance.role !== 'legal_advisor' || guidance.scope !== input.scope
      || guidance.revision_sha256 !== input.revision_sha256
      || guidance.advice_status !== 'advisory_only' || guidance.human_review !== 'pending_human_review'
      || guidance.synthetic_only !== true || !SHA256.test(guidance.decision_digest || '')
      || !Array.isArray(guidance.requirement_codes) || guidance.requirement_codes.length < 1 || guidance.requirement_codes.length > 20
      || guidance.requirement_codes.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(code))
      || new Set(guidance.requirement_codes).size !== guidance.requirement_codes.length
      || !Array.isArray(guidance.alternative_codes) || guidance.alternative_codes.length < 1 || guidance.alternative_codes.length > 8
      || guidance.alternative_codes.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(code))
      || new Set(guidance.alternative_codes).size !== guidance.alternative_codes.length
      || !Array.isArray(guidance.source_checks) || guidance.source_checks.length < 1 || guidance.source_checks.length > 10) {
    return fail('LEGAL_CONSULTATION_REQUIRED');
  }
  for (const source of guidance.source_checks) {
    if (!exactKeys(source, ['url', 'checked_at', 'source_digest']) || typeof source.url !== 'string'
        || !ISO_TIMESTAMP(source.checked_at) || Date.parse(source.checked_at) > now
        || now - Date.parse(source.checked_at) > 14 * 24 * 60 * 60 * 1000
        || !SHA256.test(source.source_digest || '')) return fail('LEGAL_SOURCE_CHECK_INVALID');
    let parsed;
    try { parsed = new URL(source.url); } catch { return fail('LEGAL_SOURCE_CHECK_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !OFFICIAL_SOURCE_HOSTS.has(parsed.hostname)) {
      return fail('LEGAL_SOURCE_NOT_ALLOWLISTED');
    }
  }
  return { ok: true, code: 'LEGAL_CONSULTATION_RECORDED', status: 'advisory_only',
    scope: input.scope, revision_sha256: input.revision_sha256,
    decision_digest: guidance.decision_digest, human_review: 'pending_human_review',
    live_cutover_authorized: false, permission_escalation: false };
}

const INSPECTOR_CODES = new Set([
  'ci_workflow_failure',
  'worker_queue_failure',
  'worker_expired_lease',
  'qwen_repeated_failure',
  'qwen_stuck_run',
  'synthetic_ci_workflow_failure',
]);

function validPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function findAgentDisputes(pulls = []) {
  if (!Array.isArray(pulls) || pulls.length > 25) return { limited: true, disputes: [] };
  const result = [];
  for (let i = 0; i < pulls.length; i++) {
    const a = pulls[i];
    if (!a || !Array.isArray(a.files)) continue;
    for (let j = i + 1; j < pulls.length; j++) {
      const b = pulls[j];
      if (!b || !Array.isArray(b.files)) continue;
      const bFiles = new Set(b.files);
      const overlap = a.files.filter(file =>
        typeof file === 'string'
        && bFiles.has(file)
        && !file.startsWith('docs/')
        && file !== 'CHANGELOG.md'
      ).slice(0, 8);
      if (!overlap.length) continue;
      result.push({
        prs: [a.number, b.number].filter(number => validPositiveInteger(number, 100_000_000)).sort((x, y) => x - y),
        files: overlap,
        highRisk: overlap.some(file => file.startsWith('supabase/') || file.startsWith('.github/') || file.startsWith('ru-migration/app/backend/')),
      });
    }
  }
  return { limited: false, disputes: result };
}

export function buildAgentIntegrationPlan({ pulls = [], disputes = [] } = {}) {
  if (!Array.isArray(pulls) || !Array.isArray(disputes)) throw new TypeError('invalid integration input');
  const pullMap = new Map(pulls.map(pull => [pull.number, pull]));
  const adjacency = new Map();
  for (const dispute of disputes) {
    const [a, b] = dispute.prs || [];
    if (!validPositiveInteger(a, 100_000_000) || !validPositiveInteger(b, 100_000_000)) continue;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  const seen = new Set();
  const groups = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    const prs = [];
    seen.add(start);
    while (stack.length) {
      const current = stack.pop();
      prs.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    prs.sort((a, b) => a - b);
    const member = disputes.filter(dispute =>
      dispute.prs?.length === 2
      && prs.includes(dispute.prs[0])
      && prs.includes(dispute.prs[1])
    );
    const files = [...new Set(member.flatMap(dispute => dispute.files || []))].sort().slice(0, 10);
    const highRisk = member.some(dispute => dispute.highRisk);
    groups.push({
      prs,
      conflictCount: member.length,
      files,
      highRisk,
      reviewSequence: [
        ...prs.filter(number => pullMap.get(number)?.draft === false),
        ...prs.filter(number => pullMap.get(number)?.draft === true),
        ...prs.filter(number => !pullMap.has(number) || typeof pullMap.get(number)?.draft !== 'boolean'),
      ],
      recommendation: highRisk
        ? 'Сначала независимый security review защищённых файлов и CI. Главный PR выбирается вручную.'
        : 'Сравнить diff и тесты. Обновить пересекающиеся ветки относительно проверенного изменения вручную.',
    });
  }
  groups.sort((a, b) => Number(b.highRisk) - Number(a.highRisk) || b.conflictCount - a.conflictCount || a.prs[0] - b.prs[0]);
  return Object.freeze({ groups: Object.freeze(groups), overlapPairs: disputes.length });
}

export function inspectInfrastructureSignals({ queue = null, warnings = [], now = Date.now() } = {}) {
  const result = [];
  if (queue && typeof queue === 'object') {
    if (Number.isSafeInteger(queue.failed_last_24h) && queue.failed_last_24h >= 3) {
      result.push({ code: 'worker_queue_failure', severity: 'high', count: queue.failed_last_24h });
    }
    if (Number.isSafeInteger(queue.expired_leases) && queue.expired_leases > 0) {
      result.push({ code: 'worker_expired_lease', severity: 'high', count: queue.expired_leases });
    }
  }
  for (const warning of warnings) {
    if (!warning || typeof warning.code !== 'string') continue;
    const mapping = {
      repeated_failures: 'qwen_repeated_failure',
      stuck_runs: 'qwen_stuck_run',
      postmerge_workflow_failure: 'ci_workflow_failure',
    };
    const code = mapping[warning.code];
    if (code && INSPECTOR_CODES.has(code) && warning.severity === 'high') {
      const count = Number.isSafeInteger(warning.count) ? Math.min(1000, Math.max(1, warning.count)) : 1;
      result.push({ code, severity: 'high', count });
    }
  }
  return Object.freeze([...new Map(result.map(item => [item.code, item])).values()]);
}

export function proposeHumanRecruitment({ disputes = [], signals = [], activeRoleKeys = [] } = {}) {
  const proposals = [];
  if (disputes.length >= 3 && !activeRoleKeys.includes('integrator')) {
    proposals.push({
      key: 'integration_specialist',
      role: 'Координатор интеграции изменений',
      reason: 'Три и более пересечения открытых PR подтверждены на уровне файлов.',
      permissions: 'Read-only diff, рекомендации порядка review, без merge и найма.',
    });
  }
  if (signals.some(signal => signal.code === 'qwen_repeated_failure') && !activeRoleKeys.includes('recruiter')) {
    proposals.push({
      key: 'coder_diagnostician',
      role: 'Диагност локального кодирующего агента',
      reason: 'Повторяющиеся сбои требуют отдельного технического анализа.',
      permissions: 'Анализ агрегированных статусов CI, без секретов и без автоматического найма.',
    });
  }
  return Object.freeze(proposals);
}

export function validateInspectorSignal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 3
      || !Object.hasOwn(input, 'signal_code')
      || !Object.hasOwn(input, 'event_id')
      || !Object.hasOwn(input, 'occurrences')) {
    return { ok: false, code: 'INVALID_INSPECTOR_SIGNAL' };
  }
  if (!INSPECTOR_CODES.has(input.signal_code)
      || typeof input.event_id !== 'string'
      || !/^[a-z0-9:_-]{3,100}$/.test(input.event_id)
      || !validPositiveInteger(input.occurrences, 1000)) {
    return { ok: false, code: 'INVALID_INSPECTOR_SIGNAL' };
  }
  return { ok: true, code: 'INSPECTOR_SIGNAL_ACCEPTED' };
}

export function createAgentTeamLifecycleTask({ role, task, fileAllowlist = [], requiresApproval = true } = {}) {
  if (role === 'developer' && requiresApproval !== true) {
    return { ok: false, code: 'MANUAL_APPROVAL_REQUIRED' };
  }
  return validateAgentTeamTask({
    role,
    payload: {
      task,
      file_allowlist: fileAllowlist,
      requires_approval: requiresApproval,
    },
  });
}
