export const FAM_AGENT_TEAM = Object.freeze([
  Object.freeze({ key: 'coordinator', title: 'Координатор', allows_model: false, permissions: Object.freeze(['prioritize', 'collect_results']) }),
  Object.freeze({ key: 'developer', title: 'Разработчик / локальная модель Qwen', allows_model: true, permissions: Object.freeze(['prepare_patch']) }),
  Object.freeze({ key: 'tester', title: 'Тестировщик', allows_model: false, permissions: Object.freeze(['run_regression', 'check_syntax']) }),
  Object.freeze({ key: 'security_reviewer', title: 'Рецензент безопасности', allows_model: false, permissions: Object.freeze(['review_diff', 'check_secrets']) }),
  Object.freeze({ key: 'analyst', title: 'Аналитик', allows_model: false, permissions: Object.freeze(['aggregate_results']) }),
  Object.freeze({ key: 'documentator', title: 'Документатор', allows_model: false, permissions: Object.freeze(['update_docs']) }),
  Object.freeze({ key: 'russian_editor', title: 'Специалист по русскому интерфейсу', allows_model: false, permissions: Object.freeze(['review_language']) }),
]);

const ROLE_KEYS = new Set(FAM_AGENT_TEAM.map(role => role.key));

export function validateAgentTeamTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'payload,role') {
    return { ok: false, code: 'INVALID_AGENT_TEAM_TASK' };
  }
  if (!ROLE_KEYS.has(input.role) || typeof input.payload !== 'object'
      || input.payload === null || Array.isArray(input.payload)
      || Object.keys(input.payload).length > 8) {
    return { ok: false, code: 'INVALID_AGENT_TEAM_TASK' };
  }
  const allowedPayloadKeys = new Set(['task', 'file_allowlist', 'requires_approval', 'aggregate_count']);
  if (!Object.keys(input.payload).every(key => allowedPayloadKeys.has(key))) {
    return { ok: false, code: 'UNAPPROVED_AGENT_TEAM_FIELD' };
  }
  if (typeof input.payload.task !== 'string' || input.payload.task.length < 3
      || input.payload.task.length > 500) {
    return { ok: false, code: 'INVALID_AGENT_TEAM_TASK' };
  }
  if (Object.hasOwn(input.payload, 'requires_approval')
      && typeof input.payload.requires_approval !== 'boolean') {
    return { ok: false, code: 'INVALID_AGENT_TEAM_TASK' };
  }
  if (input.payload.file_allowlist !== undefined
      && (!Array.isArray(input.payload.file_allowlist)
        || input.payload.file_allowlist.length > 20
        || input.payload.file_allowlist.some(value => typeof value !== 'string'))) {
    return { ok: false, code: 'INVALID_AGENT_TEAM_TASK' };
  }
  if (Object.hasOwn(input.payload, 'aggregate_count')
      && (!Number.isSafeInteger(input.payload.aggregate_count)
        || input.payload.aggregate_count < 0
        || input.payload.aggregate_count > 10_000_000)) {
    return { ok: false, code: 'INVALID_AGENT_TEAM_TASK' };
  }
  return { ok: true, code: 'AGENT_TEAM_TASK_ACCEPTED' };
}
