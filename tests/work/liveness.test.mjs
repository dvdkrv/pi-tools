import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { pidAlive, livenessOf, probeSessions } = await load('src/work/liveness.ts');

const readers = ({ alive = [], environ = {} } = {}) => ({
  kill: (pid) => {
    if (!alive.includes(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  },
  environ: (pid) => environ[pid],
});
const session = (overrides = {}) => ({
  id: 's1', file: '/s/s1.jsonl', cwd: '/src/api', name: null, pid: 10, tmuxPane: '%1', tmuxWindow: 'api',
  startedAt: '2026-09-25T08:00:00.000Z', lastTurnAt: null, endedAt: null, status: 'working', note: '', statusSource: 'auto',
  statusAt: '2026-09-25T08:00:00.000Z', restoredFrom: null, parentSession: null, headless: false, ...overrides,
});
const pane = (paneId) => ({ paneId, windowId: '@1', windowName: 'api', sessionName: 'main', path: '/src/api', command: 'node' });

test('a running process whose environment names its pane is live', () => {
  const r = readers({ alive: [10], environ: { 10: 'HOME=/h\0TMUX_PANE=%1\0' } });
  assert.equal(pidAlive(10, '%1', r), true);
  const [probed] = probeSessions([session()], [pane('%1')], r);
  assert.equal(probed.alive, true);
  assert.equal(probed.liveness, 'live');
});

test('a reused PID whose environment names another pane is not alive', () => {
  const r = readers({ alive: [10], environ: { 10: 'TMUX_PANE=%7\0' } });
  assert.equal(pidAlive(10, '%1', r), false);
  assert.equal(probeSessions([session()], [pane('%1')], r)[0].liveness, 'crashed');
});

test('without /proc, the kill check alone decides', () => {
  assert.equal(pidAlive(10, '%1', readers({ alive: [10] })), true);
});

test('a clean shutdown is closed and a dead process without one is crashed', () => {
  const r = readers();
  assert.equal(livenessOf(session({ endedAt: '2026-09-25T08:30:00.000Z' }), false, []), 'closed');
  assert.equal(livenessOf(session(), false, []), 'crashed');
  assert.equal(probeSessions([session()], [], r)[0].liveness, 'crashed');
});

test('a live process whose pane is gone is not live, and an unknown pane listing skips the pane check', () => {
  assert.equal(livenessOf(session(), true, [pane('%2')]), 'crashed');
  assert.equal(livenessOf(session(), true, undefined), 'live');
});

test('headless sessions without a pane need only a live PID', () => {
  const r = readers({ alive: [10], environ: { 10: 'TMUX_PANE=%9\0' } });
  const [probed] = probeSessions([session({ tmuxPane: null, tmuxWindow: null, headless: true })], [], r);
  assert.equal(probed.liveness, 'live');
});

test('missing and invalid PIDs are not alive', () => {
  assert.equal(pidAlive(null, null, readers({ alive: [0] })), false);
  assert.equal(pidAlive(0, null, readers({ alive: [0] })), false);
  assert.equal(pidAlive(-1, null, readers({ alive: [-1] })), false);
});
