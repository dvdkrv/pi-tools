import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { load, memoryRuntime } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');

// Deferred tools (job_register, work_propose, the lead tools) are reachable only through Pi's
// tool_search, which Pi registers inactive and enables only via defaultTools or --tools.
async function setup({ toolSearch }) {
  const rt = await memoryRuntime();
  const events = new Map();
  const registered = new Set();
  let active = ['read', 'bash'];
  const signals = new EventEmitter();
  signals.on('SIGHUP', () => {});
  signals.on('SIGTERM', () => {});
  createWorkExtension({
    runtime: () => rt, repoFromCwd: () => undefined, env: {}, pid: 4242,
    tmux: () => '', git: () => { throw new Error('not a git repository'); }, signals,
  })({
    registerCommand() {},
    registerTool(definition) { registered.add(definition.name); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
    getAllTools: () => [...registered, ...(toolSearch === 'missing' ? [] : ['tool_search'])].map((name) => ({ name })),
  });
  if (toolSearch === 'active') active.push('tool_search');
  const notes = [];
  const ctx = {
    cwd: '/tmp', mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => 's-1', getSessionFile: () => null, getSessionName: () => undefined },
    ui: { notify: (message, level) => notes.push({ message, level }), setStatus() {} },
  };
  await events.get('session_start')({ reason: 'startup' }, ctx);
  return { active: () => active, notes };
}

test('session start activates an inactive tool_search so deferred work tools stay reachable', async () => {
  const s = await setup({ toolSearch: 'inactive' });
  assert.ok(s.active().includes('tool_search'));
  assert.ok(s.active().includes('read') && s.active().includes('bash'));
  assert.deepEqual(s.notes.filter((n) => /tool_search/.test(n.message)), []);
});

test('an already active tool_search is left alone', async () => {
  const s = await setup({ toolSearch: 'active' });
  assert.equal(s.active().filter((name) => name === 'tool_search').length, 1);
});

test('a missing tool_search warns once that deferred tools cannot be called', async () => {
  const s = await setup({ toolSearch: 'missing' });
  assert.equal(s.active().includes('tool_search'), false);
  const warnings = s.notes.filter((n) => /tool_search/.test(n.message));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warning');
  assert.match(warnings[0].message, /job_register.*delegate/);
});
