import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const jobs = await load('src/work/jobs.ts');

const base = { id: 'J-1', name: 'n', kind: 'cron', ownerSession: null, itemId: null, schedule: null, pid: null, cwd: '/tmp', checkCommand: null, stopCommand: null, logPath: null, lastCheckAt: null, lastCheckStatus: null, lastCheckOutput: null, createdAt: 'x', updatedAt: 'x', stoppedAt: null };
const job = (overrides = {}) => ({ ...base, ...overrides });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('exit 0 is healthy, any other exit is unhealthy, and output is summarized to its first line', async () => {
  const cwd = tempDir();
  assert.deepEqual(await jobs.checkJob(job({ cwd, checkCommand: "printf '\\n  first line  \\nsecond\\n'" })), { status: 'healthy', output: 'first line' });
  assert.deepEqual(await jobs.checkJob(job({ cwd, checkCommand: 'echo boom >&2; exit 3' })), { status: 'unhealthy', output: 'boom' });
  assert.deepEqual(await jobs.checkJob(job({ cwd, checkCommand: 'exit 3' })), { status: 'unhealthy', output: 'exit 3' });
  assert.equal(jobs.summarize(`x\x1b[31m${'y'.repeat(300)}`).length, 200);
  assert.doesNotMatch(jobs.summarize('a\x1b[2Jb'), /\x1b/);
});

test('output is capped at 64 KB and there is no stdin', async () => {
  const cwd = tempDir();
  const big = await jobs.runShell("head -c 200000 /dev/zero | tr '\\0' a", cwd);
  assert.equal(big.output.length, jobs.OUTPUT_CAP);
  const stdin = await jobs.runShell('cat; echo done', cwd);
  assert.equal(stdin.output.trim(), 'done');
});

test('a timeout kills the whole process group and reports unknown', async () => {
  const cwd = tempDir();
  const pidFile = join(cwd, 'child.pid');
  const result = await jobs.runShell(`sleep 30 & echo $! > '${pidFile}'; wait`, cwd, { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false);
  const mapped = await jobs.checkJob(job({ checkCommand: 'x' }), { run: async () => ({ code: null, output: '', timedOut: true }) });
  assert.deepEqual(mapped, { status: 'unknown', output: 'check timed out after 15s' });
});

test('a spawn failure is unknown with the error', async () => {
  const result = await jobs.checkJob(job({ cwd: join(tempDir(), 'missing'), checkCommand: 'true' }));
  assert.equal(result.status, 'unknown');
  assert.match(result.output, /ENOENT/);
});

test('jobs without a check: a process is healthy while its PID lives, and cron stays unknown', async () => {
  const deps = { pidAlive: (pid) => pid === 7 };
  assert.deepEqual(await jobs.checkJob(job({ kind: 'process', pid: 7 }), deps), { status: 'healthy', output: 'pid 7 is running' });
  assert.deepEqual(await jobs.checkJob(job({ kind: 'process', pid: 8 }), deps), { status: 'unhealthy', output: 'pid 8 is not running' });
  assert.deepEqual(await jobs.checkJob(job({ kind: 'cron' }), deps), { status: 'unknown', output: 'no check command' });
});

test('at most 4 checks run at once, and results are recorded in input order', async () => {
  const store = await memoryStore();
  for (let i = 0; i < 10; i++) store.registerJob({ name: `job-${i}`, kind: 'cron', cwd: '/tmp', checkCommand: `check ${i}` }, 'user');
  let running = 0;
  let peak = 0;
  const run = async (command) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return { code: command.endsWith('3') ? 1 : 0, output: command, timedOut: false };
  };
  const checked = await jobs.checkJobs(store, store.listJobs(), { run });
  assert.equal(peak, 4);
  assert.deepEqual(checked.map((j) => j.name), store.listJobs().map((j) => j.name));
  assert.equal(store.listJobs().find((j) => j.name === 'job-3').lastCheckStatus, 'unhealthy');
});

test('only stale, active jobs are checked, and an aborted run records nothing', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.registerJob({ name: 'fresh', kind: 'cron', cwd: '/tmp', checkCommand: 'a' }, 'user');
  store.registerJob({ name: 'stale', kind: 'cron', cwd: '/tmp', checkCommand: 'b' }, 'user');
  store.registerJob({ name: 'gone', kind: 'cron', cwd: '/tmp', checkCommand: 'c' }, 'user');
  store.markJobStopped('J-3', 'user');
  store.recordJobCheck('J-2', 'healthy', '');
  now.advance(60_000);
  store.recordJobCheck('J-1', 'healthy', '');
  now.advance(59_000);
  assert.equal(jobs.isStale(store.getJob('J-1'), now()), false);
  assert.equal(jobs.isStale(store.getJob('J-2'), now()), true);
  const seen = [];
  await jobs.checkStaleJobs(store, { run: async (command) => { seen.push(command); return { code: 0, output: '', timedOut: false }; } });
  assert.deepEqual(seen, ['b']);
  const controller = new AbortController();
  controller.abort();
  const before = store.getJob('J-1').lastCheckAt;
  await jobs.checkJobs(store, [store.getJob('J-1')], { signal: controller.signal, run: async () => ({ code: 0, output: '', timedOut: false }) });
  assert.equal(store.getJob('J-1').lastCheckAt, before);
});

test('stopping runs the stop command, or sends SIGTERM to a process, and a failed stop changes nothing', async () => {
  const store = await memoryStore();
  store.registerJob({ name: 'with-stop', kind: 'cron', cwd: '/tmp', stopCommand: 'ok' }, 'user');
  store.registerJob({ name: 'failing', kind: 'cron', cwd: '/tmp', stopCommand: 'bad' }, 'user');
  store.registerJob({ name: 'proc', kind: 'process', cwd: '/tmp', pid: 4242 }, 'user');
  store.registerJob({ name: 'plain', kind: 'cron', cwd: '/tmp' }, 'user');
  const kills = [];
  const deps = {
    run: async (command) => (command === 'ok' ? { code: 0, output: '', timedOut: false } : { code: 2, output: 'permission denied\n', timedOut: false }),
    kill: (pid, signal) => kills.push([pid, signal]),
  };
  assert.ok((await jobs.stopJob(store, store.getJob('J-1'), 'user', deps)).job.stoppedAt);
  await assert.rejects(jobs.stopJob(store, store.getJob('J-2'), 'user', deps), /Stop command failed: permission denied/);
  assert.equal(store.getJob('J-2').stoppedAt, null);
  await jobs.stopJob(store, store.getJob('J-3'), 'user', deps);
  assert.deepEqual(kills, [[4242, 'SIGTERM']]);
  const gone = await jobs.stopJob(store, store.getJob('J-4'), 'user', deps);
  assert.match(gone.note, /no stop command/);
  const esrch = { kill: () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); } };
  store.registerJob({ name: 'exited', kind: 'process', cwd: '/tmp', pid: 4243 }, 'user');
  assert.match((await jobs.stopJob(store, store.getJob('J-5'), 'user', esrch)).note, /already exited/);
  await assert.rejects(jobs.stopJob(store, store.getJob('J-1'), 'user', deps), /already stopped/);
});
