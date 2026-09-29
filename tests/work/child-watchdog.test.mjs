import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load, until } from './helpers.mjs';

const { startWatchdog } = await load('src/work/children/watchdog.ts');
const PAIR = fileURLToPath(new URL('./fixtures/watchdog-pair.mjs', import.meta.url));

const readers = (state) => ({ ppid: () => state.ppid, alive: (pid) => state.alive.includes(pid), startTime: (pid) => state.start[pid] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gone means no such process, or a zombie that nobody has reaped yet.
function gone(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
  } catch {
    return true;
  }
}

test('the watchdog fires once when the parent changes, dies, or its PID is reused', async () => {
  for (const change of [(s) => { s.ppid = 1; }, (s) => { s.alive = []; }, (s) => { s.start[100] = '999'; }]) {
    const state = { ppid: 100, alive: [100], start: { 100: '555' } };
    let fired = 0;
    const stop = startWatchdog(() => { fired++; }, { intervalMs: 10, readers: readers(state) });
    await sleep(40);
    assert.equal(fired, 0);
    change(state);
    await until(() => fired === 1);
    await sleep(40);
    assert.equal(fired, 1);
    stop();
  }
});

test('with an explicit parent PID, only that process matters', async () => {
  const state = { ppid: 1, alive: [100], start: { 100: '555' } };
  let fired = 0;
  const stop = startWatchdog(() => { fired++; }, { parentPid: 100, intervalMs: 10, readers: readers(state) });
  await sleep(40);
  assert.equal(fired, 0);
  state.alive = [];
  await until(() => fired === 1);
  stop();
});

test('a real child exits when its parent process disappears', async () => {
  const pid = Number(execFileSync(process.execPath, [PAIR, 'parent'], { encoding: 'utf8' }).trim());
  assert.ok(pid > 0);
  await until(() => gone(pid), 5000);
});
