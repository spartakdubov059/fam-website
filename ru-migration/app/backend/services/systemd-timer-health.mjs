import { spawnSync } from 'node:child_process';

export const FAM_RU_TIMER_UNITS = Object.freeze([
  'fam-ru-orchestrator-daily-digest.timer',
  'fam-ru-coder-task-producer.timer',
  'fam-ru-pending-media-cleanup.timer',
  'fam-ru-runtime-health.timer',
  'fam-ru-safe-agent-worker.timer',
  'fam-ru-school-agent-report.timer',
  'fam-ru-site-error-digest.timer',
]);

const MAX_RUN_AGE_MS = Object.freeze({
  'fam-ru-orchestrator-daily-digest.timer': 26 * 60 * 60 * 1000,
  'fam-ru-coder-task-producer.timer': 26 * 60 * 60 * 1000,
  'fam-ru-pending-media-cleanup.timer': 7 * 60 * 60 * 1000,
  'fam-ru-runtime-health.timer': 26 * 60 * 60 * 1000,
  'fam-ru-safe-agent-worker.timer': 12 * 60 * 1000,
  'fam-ru-school-agent-report.timer': 26 * 60 * 60 * 1000,
  'fam-ru-site-error-digest.timer': 30 * 60 * 1000,
});

function parseProperties(stdout) {
  return Object.fromEntries(String(stdout || '').split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function runSystemctl(args, run = spawnSync) {
  const result = run('systemctl', args, { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (result.error || result.status !== 0) return { ok: false, stdout: '' };
  return { ok: true, stdout: result.stdout || '' };
}

export function analyzeSystemdTimerStates(states, expected = FAM_RU_TIMER_UNITS, nowMs = Date.now()) {
  const byUnit = new Map((Array.isArray(states) ? states : []).map((state) => [state.unit, state]));
  const timers = expected.map((unit) => {
    const state = byUnit.get(unit);
    const configured = state?.loadState === 'loaded'
      && state?.serviceUnit === unit.replace(/\.timer$/u, '.service');
    const enabled = state?.enabled === true;
    const active = state?.activeState === 'active';
    const nextScheduled = typeof state?.nextElapse === 'string' && state.nextElapse !== '' && state.nextElapse !== 'n/a';
    const lastRunMs = typeof state?.lastRunAt === 'string' ? Date.parse(state.lastRunAt) : NaN;
    const lastRunFresh = Number.isFinite(lastRunMs) && lastRunMs <= nowMs && nowMs - lastRunMs <= (MAX_RUN_AGE_MS[unit] ?? 0);
    const lastRunSucceeded = state?.lastRunResult === 'success' && state?.lastRunCode === 'exited' && state?.lastRunStatus === '0';
    return { unit, configured, enabled, active, nextScheduled, lastRunSucceeded, lastRunFresh,
      ok: configured && enabled && active && nextScheduled && lastRunSucceeded && lastRunFresh };
  });
  return { ok: timers.every((timer) => timer.ok), timers };
}

export function checkSystemdTimerHealth({ run = spawnSync, expected = FAM_RU_TIMER_UNITS, nowMs = Date.now() } = {}) {
  const states = expected.map((unit) => {
    const properties = runSystemctl(['show', unit, '--property=LoadState,ActiveState,NextElapseUSecRealtime,Unit'], run);
    const enabledResult = runSystemctl(['is-enabled', unit], run);
    const serviceUnit = unit.replace(/\.timer$/u, '.service');
    const serviceProperties = runSystemctl(['show', serviceUnit, '--property=Result,ExecMainCode,ExecMainStatus,ExecMainStartTimestamp'], run);
    const props = parseProperties(properties.stdout);
    const service = parseProperties(serviceProperties.stdout);
    return {
      unit,
      loadState: properties.ok ? props.LoadState : 'unavailable',
      activeState: properties.ok ? props.ActiveState : 'unavailable',
      nextElapse: properties.ok ? props.NextElapseUSecRealtime : '',
      serviceUnit: properties.ok ? props.Unit : '',
      enabled: enabledResult.ok && enabledResult.stdout.trim() === 'enabled',
      lastRunResult: serviceProperties.ok ? service.Result : '',
      lastRunCode: serviceProperties.ok ? service.ExecMainCode : '',
      lastRunStatus: serviceProperties.ok ? service.ExecMainStatus : '',
      lastRunAt: serviceProperties.ok ? service.ExecMainStartTimestamp : '',
    };
  });
  return analyzeSystemdTimerStates(states, expected, nowMs);
}
