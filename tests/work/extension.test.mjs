import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { load, memoryRuntime } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');

function setup(runtime, env = {}) {
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  createWorkExtension({ runtime: () => runtime, repoFromCwd: () => 'payments-api', env, git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter() })({
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
    getAllTools: () => [{ name: 'tool_search' }],
    getActiveTools: () => [],
    setActiveTools() {},
  });
  return { commands, tools, events };
}

function context() {
  const notes = [];
  const statuses = [];
  return {
    ctx: {
      cwd: '/src/payments-api',
      mode: 'tui',
      hasUI: true,
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => undefined, getSessionName: () => undefined },
      ui: { notify: (message, level) => notes.push({ message, level }), setStatus: (key, value) => statuses.push({ key, value }) },
    },
    notes,
    statuses,
  };
}

const paymentsConfig = { github: { accounts: [] }, projects: [{ slug: 'payments', title: 'Payments' }], rules: [{ repo: 'payments-api', project: 'payments' }] };

test('/todo captures into the project mapped from the current repository', async () => {
  const rt = await memoryRuntime({ config: paymentsConfig });
  const { commands } = setup(rt);
  const c = context();
  await commands.get('todo')('fix flaky test due:2026-10-01', c.ctx);
  assert.deepEqual(c.notes, [{ message: 'W-1 added to payments', level: 'info' }]);
  await commands.get('todo')('', c.ctx);
  assert.equal(c.notes.at(-1).level, 'warning');
  await commands.get('todo')('x #nope', c.ctx);
  assert.equal(c.notes.at(-1).level, 'error');
});

test('work_propose has a static schema, records the session, updates the badge, and enforces the limit', async () => {
  const rt = await memoryRuntime({ config: paymentsConfig });
  const { tools } = setup(rt);
  const tool = tools.get('work_propose');
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  assert.equal(Object.hasOwn(tool, 'promptGuidelines'), false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['evidence', 'project', 'reason', 'relates_to', 'title']);
  const c = context();
  for (let i = 0; i < 5; i++) {
    const result = await tool.execute(`call-${i}`, { title: `Follow-up ${i}`, reason: 'r' }, undefined, undefined, c.ctx);
    assert.equal(result.details.status, 'created');
  }
  const refused = await tool.execute('call-6', { title: 'Sixth follow-up', reason: 'r' }, undefined, undefined, c.ctx);
  assert.equal(refused.details.status, 'refused');
  assert.deepEqual(rt.store.listCandidates()[0].proposer, { sessionId: 'session-1', repo: 'payments-api' });
  assert.deepEqual(c.statuses.at(-1), { key: 'work', value: 'inbox 5' });
});

test('session_start shows the inbox badge, and planner tools are absent outside the planner', async () => {
  const rt = await memoryRuntime();
  rt.store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k', title: 't', reason: 'r' }, 'sync:github');
  const { events, tools } = setup(rt);
  const c = context();
  await events.get('session_start')({}, c.ctx);
  assert.deepEqual(c.statuses.at(-1), { key: 'work', value: 'inbox 1' });
  assert.equal(tools.has('work_snapshot'), false);
});

test('/triage refuses non-interactive modes', async () => {
  const rt = await memoryRuntime();
  const { commands } = setup(rt);
  const c = context();
  c.ctx.mode = 'print';
  await commands.get('triage')('', c.ctx);
  assert.match(c.notes[0].message, /work triage/);
});

test('/dash opens the dashboard in a tmux popup, and warns outside tmux', async () => {
  const { dashCommand } = await load('extensions/work.ts');
  const rt = await memoryRuntime();
  const popups = [];
  const commands = new Map();
  const make = (env) => createWorkExtension({ runtime: () => rt, env, git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter(), popup: (args) => popups.push(args) })({
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool() {},
    on() {},
    getAllTools: () => [{ name: 'tool_search' }],
    getActiveTools: () => [],
    setActiveTools() {},
  });
  const c = context();
  make({});
  await commands.get('dash')('', c.ctx);
  assert.match(c.notes.at(-1).message, /work dash/);
  assert.equal(popups.length, 0);
  make({ TMUX: '/tmp/tmux-1000/default,1,0' });
  await commands.get('dash')('', c.ctx);
  assert.deepEqual(popups[0].slice(0, 6), ['display-popup', '-E', '-w', '90%', '-h', '90%']);
  assert.match(popups[0][6], /bin\/work\.ts' dash$/);
  assert.match(dashCommand('/opt/pi/bin/pi'), /^'node' '.*bin\/work\.ts' dash$/);
  assert.match(dashCommand('/usr/local/bin/node'), /^'\/usr\/local\/bin\/node' /);
});

test('a bash call without a timeout gets the bashTimeoutMinutes default; one with a timeout keeps it', async () => {
  const rt = await memoryRuntime({ config: { ...paymentsConfig, bashTimeoutMinutes: 2 } });
  const { events } = setup(rt);
  const bare = { command: 'sleep 1000' };
  assert.equal(await events.get('tool_call')({ toolName: 'bash', input: bare }, context().ctx), undefined);
  assert.equal(bare.timeout, 120);
  const own = { command: 'make', timeout: 7200 };
  await events.get('tool_call')({ toolName: 'bash', input: own }, context().ctx);
  assert.equal(own.timeout, 7200);
  const read = { path: 'x' };
  await events.get('tool_call')({ toolName: 'read', input: read }, context().ctx);
  assert.equal(read.timeout, undefined);
  const defaults = setup(await memoryRuntime({ config: paymentsConfig }));
  const input = { command: 'ls', timeout: 0 };
  await defaults.events.get('tool_call')({ toolName: 'bash', input }, context().ctx);
  assert.equal(input.timeout, 1800);
});

test('loading the extension disables D-Bus autolaunch for every command the session runs, unless a bus is set', () => {
  const unset = {};
  setup(undefined, unset);
  assert.equal(unset.DBUS_SESSION_BUS_ADDRESS, 'disabled:');
  const set = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' };
  setup(undefined, set);
  assert.equal(set.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1/bus');
});
