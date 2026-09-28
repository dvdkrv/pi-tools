import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { clock, load, memoryRuntime } from './helpers.mjs';

const { createWorkExtension, SESSION_STATUS_DESCRIPTION } = await load('extensions/work.ts');
const { shutdownIsClean } = await load('src/work/session-tracker.ts');

const IN_TMUX = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3' };

function fakeTmux(state) {
  return (args) => {
    if (args[0] === 'display-message') return `${state.window}\n`;
    if (args[0] === 'list-panes') {
      if (state.serverGone) throw new Error('no server running');
      return state.panes.map((pane) => `${pane}\t@1\tapi\tmain\t/src/api\tzsh`).join('\n');
    }
    return '';
  };
}

function setup({ runtime, env = IN_TMUX, mode = 'tui' } = {}) {
  const tools = new Map();
  const events = new Map();
  const signals = new EventEmitter();
  // Stand-ins for Pi's own signal handlers; the extension only listens when Pi does.
  signals.on('SIGHUP', () => {});
  signals.on('SIGTERM', () => {});
  const tmuxState = { window: 'api', panes: ['%3'], serverGone: false };
  createWorkExtension({
    runtime: () => runtime,
    repoFromCwd: () => undefined,
    env,
    pid: 4242,
    tmux: fakeTmux(tmuxState),
    git: () => { throw new Error('not a git repository'); },
    signals,
  })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
  });
  const notes = [];
  const ctx = {
    cwd: '/src/api',
    mode,
    hasUI: mode === 'tui',
    sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/s/sess-1.jsonl', getSessionName: () => undefined },
    ui: { notify: (message, level) => notes.push({ message, level }), setStatus() {} },
  };
  const emit = (name, event = {}) => events.get(name)(event, ctx);
  return { tools, emit, ctx, notes, signals, tmuxState };
}

const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('session_start registers a tmux session with its pane, window, and file', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.pid, 4242);
  assert.equal(row.tmuxPane, '%3');
  assert.equal(row.tmuxWindow, 'api');
  assert.equal(row.file, '/s/sess-1.jsonl');
  assert.equal(row.cwd, '/src/api');
  assert.equal(row.headless, false);
  assert.equal(row.parentSession, null);
  assert.equal(row.status, 'needs-me');
  assert.equal(row.note, 'new session');
});

test('a child in rpc mode registers as headless, with its parent and no pane', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, mode: 'rpc', env: { ...IN_TMUX, PI_WORK_PARENT_SESSION: 'parent-1' } });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.headless, true);
  assert.equal(row.parentSession, 'parent-1');
  assert.equal(row.tmuxPane, null);
  assert.equal(row.tmuxWindow, null);
  const result = await s.tools.get('session_status').execute('c1', { status: 'needs-me', note: 'Which runner?' }, undefined, undefined, s.ctx);
  assert.equal(result.details.recorded, true);
});

test('a terminal session outside tmux registers as top-level and interactive, without a pane', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: {} });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.deepEqual([row.headless, row.parentSession, row.tmuxPane, row.tmuxWindow], [false, null, null, null]);
});

test('a terminal session is never a child, even with an inherited PI_WORK_PARENT_SESSION', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: { ...IN_TMUX, PI_WORK_PARENT_SESSION: 'parent-1' } });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.deepEqual([row.headless, row.parentSession, row.tmuxPane], [false, null, '%3']);
});

test('rpc always registers, and print and json runs register only as children', async () => {
  for (const [mode, env, registered] of [
    ['rpc', IN_TMUX, true],
    ['rpc', {}, true],
    ['print', IN_TMUX, false],
    ['json', {}, false],
    ['print', { ...IN_TMUX, PI_WORK_PARENT_SESSION: 'parent-1' }, true],
    ['json', { PI_WORK_PARENT_SESSION: 'parent-1' }, true],
  ]) {
    const label = `${mode} ${JSON.stringify(env)}`;
    const rt = await memoryRuntime();
    const s = setup({ runtime: rt, mode, env });
    await s.emit('session_start', { reason: 'startup' });
    const row = rt.store.getSession('sess-1');
    assert.equal(Boolean(row), registered, label);
    if (row) assert.deepEqual([row.headless, row.tmuxPane, row.tmuxWindow], [true, null, null], label);
    const result = await s.tools.get('session_status').execute('c1', { status: 'done', note: 'Finished' }, undefined, undefined, s.ctx);
    assert.equal(result.details.recorded, registered, label);
  }
});

test('a run is working, and without a declaration it ends as needs-me with the last line as its note', async () => {
  const now = clock();
  const rt = await memoryRuntime({ now });
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  now.advance(1000);
  await s.emit('agent_start');
  assert.equal(rt.store.getSession('sess-1').status, 'working');
  s.tmuxState.window = 'api-renamed';
  now.advance(1000);
  await s.emit('agent_end', { messages: [assistant('Done with step one.\n\nShould I also update the docs?')] });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.status, 'needs-me');
  assert.equal(row.statusSource, 'auto');
  assert.equal(row.note, 'Should I also update the docs?');
  assert.equal(row.tmuxWindow, 'api-renamed');
  assert.equal(row.lastTurnAt, '2026-09-25T09:00:02.000Z');
});

test('a declared status wins over the fallback, the last declaration wins, and the next run resets it', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  const tool = s.tools.get('session_status');
  await tool.execute('c1', { status: 'needs-me', note: 'Which option?' }, undefined, undefined, s.ctx);
  await tool.execute('c2', { status: 'waiting-external', note: 'CI run 123 is pending' }, undefined, undefined, s.ctx);
  await s.emit('agent_end', { messages: [assistant('Waiting for CI.')] });
  let row = rt.store.getSession('sess-1');
  assert.equal(row.status, 'waiting-external');
  assert.equal(row.statusSource, 'agent');
  assert.equal(row.note, 'CI run 123 is pending');
  await s.emit('agent_start');
  await s.emit('agent_end', { messages: [] });
  row = rt.store.getSession('sess-1');
  assert.equal(row.status, 'needs-me');
  assert.equal(row.statusSource, 'auto');
});

test('session_status has a static schema and the spec description', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  const tool = s.tools.get('session_status');
  assert.equal(tool.description, SESSION_STATUS_DESCRIPTION);
  assert.match(tool.description, /^Declare this session's state as your final action in a turn/);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['note', 'status']);
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  const early = await tool.execute('c0', { status: 'done', note: 'Shipped' }, undefined, undefined, s.ctx);
  assert.equal(early.details.recorded, false);
});

test('a resumed session keeps its status, and renames are recorded', async () => {
  const rt = await memoryRuntime();
  const first = setup({ runtime: rt });
  await first.emit('session_start', { reason: 'startup' });
  rt.store.setSessionStatus('sess-1', 'waiting-external', 'Review from a teammate', 'agent');
  await first.emit('session_shutdown', { reason: 'quit' });
  assert.ok(rt.store.getSession('sess-1').endedAt);
  const second = setup({ runtime: rt });
  await second.emit('session_start', { reason: 'resume' });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.endedAt, null);
  assert.equal(row.status, 'waiting-external');
  await second.emit('session_info_changed', { name: 'Fix flaky test' });
  assert.equal(rt.store.getSession('sess-1').name, 'Fix flaky test');
});

test('a signal leaves the session crashed while its pane exists or tmux is gone; closing the pane is clean', async () => {
  for (const [label, change, ended] of [
    ['pane still open', () => {}, false],
    ['server gone', (state) => { state.serverGone = true; }, false],
    ['pane closed', (state) => { state.panes = []; }, true],
  ]) {
    const rt = await memoryRuntime();
    const s = setup({ runtime: rt });
    await s.emit('session_start', { reason: 'startup' });
    change(s.tmuxState);
    s.signals.emit('SIGHUP');
    await s.emit('session_shutdown', { reason: 'quit' });
    assert.equal(Boolean(rt.store.getSession('sess-1').endedAt), ended, label);
  }
});

test("the shutdown hook sees the signal even though Pi's handler starts shutdown first", async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  let shutdown;
  s.signals.prependListener('SIGTERM', () => { shutdown = s.emit('session_shutdown', { reason: 'quit' }); });
  s.signals.emit('SIGTERM');
  await shutdown;
  assert.equal(rt.store.getSession('sess-1').endedAt, null);
});

test('a registry failure warns once and stops recording for the session', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  rt.store.close();
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  await s.emit('agent_end', { messages: [] });
  const warnings = s.notes.filter((note) => note.level === 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /registry is off/);
});

test('PI_WORK_ITEM links the session to its item at start', async () => {
  const rt = await memoryRuntime();
  rt.store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const s = setup({ runtime: rt, env: { ...IN_TMUX, PI_WORK_ITEM: 'W-1' } });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(rt.store.sessionLink('sess-1').itemId, 'W-1');
});

test('shutdownIsClean covers every combination', () => {
  const panes = (list) => () => {
    if (list === null) throw new Error('no server running');
    return list.map((pane) => `${pane}\t@1\tw\ts\t/p\tzsh`).join('\n');
  };
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: false, pane: '%1', tmux: panes(['%1']) }), true);
  assert.equal(shutdownIsClean({ reason: 'reload', signalled: true, pane: '%1', tmux: panes(['%1']) }), true);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: null, tmux: panes(null) }), true);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: '%1', tmux: panes(['%1']) }), false);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: '%1', tmux: panes(null) }), false);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: '%1', tmux: panes(['%2']) }), true);
});
