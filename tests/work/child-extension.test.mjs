import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { git, gitRepo, load, memoryRuntime, writeFiles } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');

const BRIEF = { goal: 'Add retry', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null };

function setup({ runtime, env, cwd }) {
  const events = new Map();
  const tools = new Map();
  const watchdogs = [];
  const calls = [];
  createWorkExtension({
    runtime: () => runtime,
    repoFromCwd: () => undefined,
    env,
    pid: 777,
    tmux: () => '',
    git: () => { throw new Error('not a git repository'); },
    signals: new EventEmitter(),
    watchdog: (onGone, options) => {
      watchdogs.push({ onGone, options });
      return () => calls.push('watchdog stopped');
    },
  })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
  });
  const ctx = {
    cwd,
    mode: 'rpc',
    hasUI: true,
    sessionManager: { getSessionId: () => 'child-s1', getSessionFile: () => undefined, getSessionName: () => undefined },
    ui: { notify() {}, setStatus() {} },
    abort: () => calls.push('abort'),
    shutdown: () => calls.push('shutdown'),
  };
  return { events, tools, watchdogs, calls, ctx, emit: (name, event = {}) => events.get(name)(event, ctx) };
}

async function child({ budgetLines = 300 } = {}) {
  const rt = await memoryRuntime();
  const repo = gitRepo({ 'src/a.ts': 'one\n' });
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  rt.store.createChildRun({ leadSession: 'lead-1', brief: BRIEF, model: 'anthropic/claude-sonnet-5', repo: 'api', budgetLines, budgetFiles: 8 }, 'session:lead-1', () => ({ worktree: repo, branch: 'main', baseCommit }));
  const env = { PI_WORK_CHILD_RUN: 'C-1', PI_WORK_PARENT_SESSION: 'lead-1', PI_WORK_PARENT_PID: '999' };
  return { rt, repo, s: setup({ runtime: rt, env, cwd: repo }) };
}

test('a child blocks changes until its guards start, then enforces scope, commands, and timeouts', async () => {
  const { s } = await child();
  assert.match((await s.emit('tool_call', { toolName: 'edit', input: { path: 'src/a.ts' } })).reason, /not started/);
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(await s.emit('tool_call', { toolName: 'edit', input: { path: 'src/a.ts' } }), undefined);
  assert.match((await s.emit('tool_call', { toolName: 'write', input: { path: 'docs/x.md' } })).reason, /outside your scope/);
  assert.match((await s.emit('tool_call', { toolName: 'bash', input: { command: 'npm test' } })).reason, /repository-wide test run/);
  const input = { command: 'ls', timeout: 9999 };
  assert.equal(await s.emit('tool_call', { toolName: 'bash', input }), undefined);
  assert.equal(input.timeout, 600);
  assert.deepEqual(s.watchdogs.map((w) => w.options), [{ parentPid: 999 }]);
  s.watchdogs[0].onGone();
  assert.deepEqual(s.calls, ['abort', 'shutdown']);
  await s.emit('session_shutdown', { reason: 'quit' });
  assert.equal(s.calls.at(-1), 'watchdog stopped');
});

test('tool results carry budget warnings, and diff and spend are recorded in the registry', async () => {
  const { s, rt, repo } = await child({ budgetLines: 5 });
  await s.emit('session_start', { reason: 'startup' });
  writeFiles(repo, { 'src/b.ts': '1\n2\n3\n4\n' });
  const result = await s.emit('tool_result', { toolName: 'write', content: [{ type: 'text', text: 'wrote' }] });
  assert.deepEqual(result.content, [{ type: 'text', text: 'wrote' }, { type: 'text', text: 'Budget 4/5 lines: finish the smallest working change.' }]);
  assert.equal(rt.store.getChildRun('C-1').diffLines, 4);
  await s.emit('message_end', { message: { role: 'assistant', content: [], usage: { cost: { total: 0.4 } } } });
  await s.emit('message_end', { message: { role: 'user', content: 'x' } });
  assert.equal(rt.store.getChildRun('C-1').spendUsd, 0.4);
  assert.equal(await s.emit('tool_result', { toolName: 'read', content: [] }), undefined);
});

test('an unknown child run fails closed and still starts the watchdog', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: { PI_WORK_CHILD_RUN: 'C-9', PI_WORK_PARENT_SESSION: 'lead-1' }, cwd: '/src/api' });
  await s.emit('session_start', { reason: 'startup' });
  assert.match((await s.emit('tool_call', { toolName: 'bash', input: { command: 'ls' } })).reason, /work registry is unavailable/);
  assert.equal(await s.emit('tool_call', { toolName: 'read', input: { path: 'a' } }), undefined);
  assert.deepEqual(s.watchdogs.map((w) => w.options), [{ parentPid: undefined }]);
});

test('sessions that are not children register no guard hooks', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: {}, cwd: '/src/api' });
  assert.equal(s.events.has('tool_result'), false);
  // tool_call only sets the default bash timeout here; it blocks nothing.
  const input = { command: 'npm test' };
  assert.equal(await s.emit('tool_call', { toolName: 'bash', input }), undefined);
  assert.equal(input.timeout, 1800);
  assert.equal(await s.emit('tool_call', { toolName: 'edit', input: { path: '/etc/passwd' } }), undefined);
  // message_end is shared with session_status's visible-text check, but never records child spend here.
  await s.emit('message_end', { message: { role: 'assistant', content: [], usage: { cost: { total: 0.4 } } } });
  assert.equal(rt.store.listChildRuns().length, 0);
});
