import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { captureIo, load, memoryRuntime, tempDir } from './helpers.mjs';

const { createWorkExtension, JOB_REGISTER_DESCRIPTION } = await load('extensions/work.ts');
const { registerAgentJob, formatJob } = await load('src/work/jobs.ts');
const { runCli, parseFlags } = await load('src/work/cli.ts');

async function cli(rt, argv, cwd = '/srv') {
  const io = captureIo();
  const code = await runCli(argv, { runtime: () => rt, io: io.io, cwd, env: {}, repoFromCwd: () => undefined });
  return { code, ...io };
}

test('registerAgentJob fills the owner and item from the session, and relates_to overrides the item', async () => {
  const rt = await memoryRuntime();
  const a = rt.store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const b = rt.store.addItem({ project: 'misc', title: 'B', origin: 'manual' }, 'user');
  rt.store.startSession({ id: 's1', file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: true });
  rt.store.linkSession('s1', a.id, 'env', 'session:s1');
  const first = registerAgentJob(rt.store, { name: 'dev-server', kind: 'process', cwd: '/src/api', pid: 4242, check_command: 'curl -fs localhost:8080/health' }, 's1');
  assert.equal(first.created, true);
  assert.deepEqual([first.job.ownerSession, first.job.itemId, first.job.pid, first.job.checkCommand], ['s1', 'W-1', 4242, 'curl -fs localhost:8080/health']);
  assert.equal(rt.store.listEvents().at(-1).actor, 'agent:s1');
  assert.match(first.message, /^Registered J-1 dev-server\./);
  const second = registerAgentJob(rt.store, { name: 'dev-server', kind: 'process', cwd: '/src/api', relates_to: b.id }, 's1');
  assert.equal(second.created, false);
  assert.equal(second.job.itemId, 'W-2');
  assert.equal(second.job.checkCommand, 'curl -fs localhost:8080/health');
  assert.match(registerAgentJob(rt.store, { name: 'other', kind: 'cron', cwd: '/', relates_to: 'W-99' }, 's1').message, /ignored unknown item W-99/);
});

test('job_register is static and registers for the calling session', async () => {
  const rt = await memoryRuntime();
  const tools = new Map();
  createWorkExtension({ runtime: () => rt, env: {}, git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter() })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on() {},
  });
  const tool = tools.get('job_register');
  assert.equal(tool.description, JOB_REGISTER_DESCRIPTION);
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['check_command', 'cwd', 'kind', 'log_path', 'name', 'pid', 'relates_to', 'schedule', 'stop_command']);
  const ctx = { sessionManager: { getSessionId: () => 'sess-9' } };
  const result = await tool.execute('c1', { name: 'nightly', kind: 'cron', cwd: '/srv', schedule: '0 3 * * *' }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { jobId: 'J-1', created: true });
  assert.equal(rt.store.getJob('J-1').ownerSession, 'sess-9');
});

test('work job add, list, and check', async () => {
  const rt = await memoryRuntime();
  const dir = tempDir();
  const added = await cli(rt, ['job', 'add', '--name', 'ok-check', '--kind', 'cron', '--schedule', '*/5 * * * *', '--check', 'echo fine']);
  assert.deepEqual([added.code, added.out], [0, ['Added J-1 ok-check']]);
  assert.equal(rt.store.getJob('J-1').cwd, '/srv');
  await cli(rt, ['job', 'add', '--name', 'bad-check', '--kind', 'cron', '--cwd', dir, '--check', 'echo broken; exit 1']);
  assert.equal(rt.store.getJob('J-2').cwd, dir);
  const listed = await cli(rt, ['job']);
  assert.match(listed.out[0].split('\n')[0], /^J-2 +unchecked +bad-check {2}cron {2}never checked$/);
  rt.store.registerJob({ name: 'ok-check', kind: 'cron', cwd: dir }, 'user');
  const checked = await cli(rt, ['job', 'check']);
  assert.equal(checked.code, 0);
  const lines = checked.out[0].split('\n');
  assert.match(lines[0], /^J-2 +unhealthy +bad-check {2}cron {2}checked 0s ago: broken$/);
  assert.match(lines[1], /^J-1 +healthy +ok-check {2}cron \*\/5 \* \* \* \* {2}checked 0s ago: fine$/);
  const one = await cli(rt, ['job', 'check', 'J-1']);
  assert.equal(one.out[0].split('\n').length, 1);
  const bad = await cli(rt, ['job', 'add', '--name', 'x']);
  assert.equal(bad.code, 1);
  assert.match(bad.err[0], /Usage: work job add/);
  const unknown = await cli(rt, ['job', 'check', 'J-9']);
  assert.match(unknown.err[0], /Unknown job: J-9/);
});

test('parseFlags and formatJob', () => {
  assert.deepEqual(parseFlags(['--name', 'a b', '--kind', 'cron'], ['name', 'kind']), { name: 'a b', kind: 'cron' });
  assert.throws(() => parseFlags(['--nope', 'x'], ['name']), /Unknown option: --nope/);
  assert.throws(() => parseFlags(['--name'], ['name']), /--name needs a value/);
  const now = new Date('2026-09-25T09:10:00.000Z');
  const stopped = { id: 'J-3', name: 'old', kind: 'process', schedule: null, stoppedAt: '2026-09-25T09:00:00.000Z', lastCheckAt: '2026-09-25T09:05:00.000Z', lastCheckStatus: 'healthy', lastCheckOutput: 'pid 1 is running' };
  assert.equal(formatJob(stopped, now), 'J-3   stopped   old  process  checked 5m ago: pid 1 is running');
});
