import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSystemdTimerStates, checkSystemdTimerHealth, FAM_RU_TIMER_UNITS } from '../services/systemd-timer-health.mjs';

test('timer health reports only the configured allowlist and never exposes timestamps', () => {
  const nowMs = Date.parse('2026-11-20T00:30:00Z');
  const states = FAM_RU_TIMER_UNITS.map(unit => ({ unit, loadState: 'loaded', serviceUnit: unit.replace(/\.timer$/u, '.service'),
    enabled: true, activeState: 'active', nextElapse: 'Sat 2026-11-21 03:30:00 UTC', lastRunResult: 'success',
    lastRunCode: 'exited', lastRunStatus: '0', lastRunAt: unit === 'fam-ru-safe-agent-worker.timer' ? '2026-11-20T00:25:00Z' : '2026-11-20T00:00:00Z' }));
  const report = analyzeSystemdTimerStates(states.concat([{ unit: 'untrusted.timer', loadState: 'loaded', enabled: true, activeState: 'active' }]), undefined, nowMs);
  assert.equal(report.ok, true);
  assert.deepEqual(report.timers.map(timer => timer.unit), [...FAM_RU_TIMER_UNITS]);
  assert.equal(JSON.stringify(report).includes('2026-11-21'), false);
  assert.equal(JSON.stringify(report).includes('untrusted'), false);
});

test('coder task producer timer is required and uses a 26-hour freshness window', () => {
  const nowMs = Date.parse('2026-11-20T00:30:00Z');
  const states = FAM_RU_TIMER_UNITS.map(unit => ({ unit, loadState: 'loaded', serviceUnit: unit.replace(/\.timer$/u, '.service'),
    enabled: true, activeState: 'active', nextElapse: 'Sat 2026-11-21 03:30:00 UTC', lastRunResult: 'success',
    lastRunCode: 'exited', lastRunStatus: '0', lastRunAt: '2026-11-20T00:00:00Z' }));
  const coder = states.find(state => state.unit === 'fam-ru-coder-task-producer.timer');
  states.find(state => state.unit === 'fam-ru-safe-agent-worker.timer').lastRunAt = '2026-11-20T00:25:00Z';
  assert.ok(coder);
  coder.lastRunAt = '2026-11-19T00:30:01Z';
  assert.equal(analyzeSystemdTimerStates(states, undefined, nowMs).ok, true);
  coder.lastRunAt = '2026-11-18T22:29:59Z';
  const report = analyzeSystemdTimerStates(states, undefined, nowMs);
  assert.equal(report.ok, false);
  assert.equal(report.timers.find(timer => timer.unit === coder.unit).lastRunFresh, false);
});

test('a disabled, inactive, missing or unconfigured timer makes the health report fail', () => {
  const states = FAM_RU_TIMER_UNITS.map(unit => ({ unit, loadState: 'loaded', serviceUnit: unit.replace(/\.timer$/u, '.service'),
    enabled: true, activeState: 'active', nextElapse: 'Sat 2026-11-21 03:30:00 UTC', lastRunResult: 'success',
    lastRunCode: 'exited', lastRunStatus: '0', lastRunAt: '2026-11-20T00:00:00Z' }));
  states.find(state => state.unit === 'fam-ru-orchestrator-daily-digest.timer').enabled = false;
  states.find(state => state.unit === 'fam-ru-coder-task-producer.timer').activeState = 'inactive';
  states.find(state => state.unit === 'fam-ru-pending-media-cleanup.timer').serviceUnit = 'fam-unrelated.service';
  states.splice(states.findIndex(state => state.unit === 'fam-ru-safe-agent-worker.timer'), 1);
  states.find(state => state.unit === 'fam-ru-runtime-health.timer').nextElapse = 'n/a';
  states.find(state => state.unit === 'fam-ru-school-agent-report.timer').enabled = false;
  states.find(state => state.unit === 'fam-ru-site-error-digest.timer').enabled = false;
  const report = analyzeSystemdTimerStates(states, undefined, Date.parse('2026-11-20T00:30:00Z'));
  assert.equal(report.ok, false);
  assert.deepEqual(report.timers.filter(timer => !timer.ok).map(timer => timer.unit), [...FAM_RU_TIMER_UNITS]);
});

test('timer health rejects failed runs and stale service executions without returning their timestamps', () => {
  const nowMs = Date.parse('2026-11-20T00:30:00Z');
  const states = FAM_RU_TIMER_UNITS.map(unit => ({ unit, loadState: 'loaded', serviceUnit: unit.replace(/\.timer$/u, '.service'),
    enabled: true, activeState: 'active', nextElapse: 'Sat 2026-11-21 03:30:00 UTC', lastRunResult: 'success',
    lastRunCode: 'exited', lastRunStatus: '0', lastRunAt: unit === 'fam-ru-safe-agent-worker.timer' ? '2026-11-20T00:25:00Z' : '2026-11-20T00:00:00Z' }));
  states[0].lastRunStatus = '1';
  states[1].lastRunAt = '2026-10-01T00:00:00Z';
  const report = analyzeSystemdTimerStates(states, undefined, nowMs);
  assert.equal(report.ok, false);
  assert.equal(report.timers[0].lastRunSucceeded, false);
  assert.equal(report.timers[1].lastRunFresh, false);
  assert.equal(report.timers.slice(2).every(timer => timer.ok), true);
  assert.equal(JSON.stringify(report).includes('2026-10-01'), false);
});

test('runtime check uses fixed systemctl arguments and fails closed on command errors', () => {
  const calls = [];
  const report = checkSystemdTimerHealth({ nowMs: Date.parse('2026-11-20T00:30:00Z'), run: (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'is-enabled') return { status: 1, stdout: 'disabled\n' };
    if (args[1]?.endsWith('.service')) return { status: 0, stdout: 'Result=success\nExecMainCode=exited\nExecMainStatus=0\nExecMainStartTimestamp=2026-11-20T00:00:00Z\n' };
    return { status: 0, stdout: `LoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=Sat 2026-11-21 03:30:00 UTC\nUnit=${args[1].replace(/\.timer$/u, '.service')}\n` };
  } });
  assert.equal(report.ok, false);
  assert.equal(calls.length, FAM_RU_TIMER_UNITS.length * 3);
  assert.ok(calls.every(([command]) => command === 'systemctl'));
  assert.ok(calls.every(([, args]) => !args.some(value => value.includes(';') || value.includes('`'))));
});
