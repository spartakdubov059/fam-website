import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSystemdTimerStates, checkSystemdTimerHealth, FAM_RU_TIMER_UNITS } from '../services/systemd-timer-health.mjs';

test('timer health reports only the configured allowlist and never exposes timestamps', () => {
  const states = FAM_RU_TIMER_UNITS.map(unit => ({ unit, loadState: 'loaded', serviceUnit: unit.replace(/\.timer$/u, '.service'),
    enabled: true, activeState: 'active', nextElapse: 'Sat 2026-11-21 03:30:00 UTC' }));
  const report = analyzeSystemdTimerStates(states.concat([{ unit: 'untrusted.timer', loadState: 'loaded', enabled: true, activeState: 'active' }]));
  assert.equal(report.ok, true);
  assert.deepEqual(report.timers.map(timer => timer.unit), [...FAM_RU_TIMER_UNITS]);
  assert.equal(JSON.stringify(report).includes('2026-11-21'), false);
  assert.equal(JSON.stringify(report).includes('untrusted'), false);
});

test('a disabled, inactive, missing or unconfigured timer makes the health report fail', () => {
  const states = FAM_RU_TIMER_UNITS.map(unit => ({ unit, loadState: 'loaded', serviceUnit: unit.replace(/\.timer$/u, '.service'),
    enabled: true, activeState: 'active', nextElapse: 'Sat 2026-11-21 03:30:00 UTC' }));
  states[0].enabled = false;
  states[1].activeState = 'inactive';
  states[2].serviceUnit = '';
  states[3].nextElapse = 'n/a';
  states.pop();
  const report = analyzeSystemdTimerStates(states);
  assert.equal(report.ok, false);
  assert.deepEqual(report.timers.filter(timer => !timer.ok).map(timer => timer.unit), [...FAM_RU_TIMER_UNITS]);
});

test('runtime check uses fixed systemctl arguments and fails closed on command errors', () => {
  const calls = [];
  const report = checkSystemdTimerHealth({ run: (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'is-enabled') return { status: 1, stdout: 'disabled\n' };
    return { status: 0, stdout: 'LoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=Sat 2026-11-21 03:30:00 UTC\nUnit=fam-ru-example.service\n' };
  } });
  assert.equal(report.ok, false);
  assert.equal(calls.length, FAM_RU_TIMER_UNITS.length * 2);
  assert.ok(calls.every(([command]) => command === 'systemctl'));
  assert.ok(calls.every(([, args]) => !args.some(value => value.includes(';') || value.includes('`'))));
});
