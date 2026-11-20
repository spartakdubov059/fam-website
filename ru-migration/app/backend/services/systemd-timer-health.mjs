import { spawnSync } from 'node:child_process';

export const FAM_RU_TIMER_UNITS = Object.freeze([
  'fam-ru-orchestrator-daily-digest.timer',
  'fam-ru-pending-media-cleanup.timer',
  'fam-ru-runtime-health.timer',
  'fam-ru-school-agent-report.timer',
  'fam-ru-site-error-digest.timer',
]);

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

export function analyzeSystemdTimerStates(states, expected = FAM_RU_TIMER_UNITS) {
  const byUnit = new Map((Array.isArray(states) ? states : []).map((state) => [state.unit, state]));
  const timers = expected.map((unit) => {
    const state = byUnit.get(unit);
    const configured = state?.loadState === 'loaded' && state?.serviceUnit?.endsWith('.service');
    const enabled = state?.enabled === true;
    const active = state?.activeState === 'active';
    const nextScheduled = typeof state?.nextElapse === 'string' && state.nextElapse !== '' && state.nextElapse !== 'n/a';
    return { unit, configured, enabled, active, nextScheduled, ok: configured && enabled && active && nextScheduled };
  });
  return { ok: timers.every((timer) => timer.ok), timers };
}

export function checkSystemdTimerHealth({ run = spawnSync, expected = FAM_RU_TIMER_UNITS } = {}) {
  const states = expected.map((unit) => {
    const properties = runSystemctl(['show', unit, '--property=LoadState,ActiveState,NextElapseUSecRealtime,Unit'], run);
    const enabledResult = runSystemctl(['is-enabled', unit], run);
    const props = parseProperties(properties.stdout);
    return {
      unit,
      loadState: properties.ok ? props.LoadState : 'unavailable',
      activeState: properties.ok ? props.ActiveState : 'unavailable',
      nextElapse: properties.ok ? props.NextElapseUSecRealtime : '',
      serviceUnit: properties.ok ? props.Unit : '',
      enabled: enabledResult.ok && enabledResult.stdout.trim() === 'enabled',
    };
  });
  return analyzeSystemdTimerStates(states, expected);
}
