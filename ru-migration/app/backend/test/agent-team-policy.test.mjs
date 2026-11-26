import test from 'node:test';
import assert from 'node:assert/strict';
import { FAM_AGENT_TEAM, validateAgentTeamTask } from '../policies/agent-team.mjs';

test('RU agent team preserves the existing sequential role set', () => {
  assert.deepEqual(FAM_AGENT_TEAM.map(role => role.key),
    ['coordinator', 'developer', 'tester', 'security_reviewer', 'analyst', 'documentator', 'russian_editor']);
  assert.equal(FAM_AGENT_TEAM.filter(role => role.allows_model).length, 1);
  assert.equal(FAM_AGENT_TEAM.find(role => role.key === 'developer').title, 'Разработчик');
});

test('RU agent team rejects model-only secrets, tools and raw payload fields', () => {
  assert.equal(validateAgentTeamTask({ role: 'developer',
    payload: { task: 'Исправить русский текст', file_allowlist: ['docs/README.md'], requires_approval: true } }).ok, true);
  assert.equal(validateAgentTeamTask({ role: 'developer',
    payload: { task: 'Запустить shell', shell: 'whoami' } }).code, 'UNAPPROVED_AGENT_TEAM_FIELD');
  assert.equal(validateAgentTeamTask({ role: 'unknown',
    payload: { task: 'Выполнить задачу' } }).code, 'INVALID_AGENT_TEAM_TASK');
  assert.equal(validateAgentTeamTask({ role: 'analyst',
    payload: { task: 'Проверить сводку', aggregate_count: 10_000_001 } }).code, 'INVALID_AGENT_TEAM_TASK');
});
