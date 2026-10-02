import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { load, memoryRuntime } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');
const { ASK_USER_DISMISSED, ASK_USER_NO_UI } = await load('src/work/ask-user.ts');
const { buildDashModel } = await load('src/work/dash/model.ts');
const { rowCells } = await load('src/work/dash/view.ts');

const IN_TMUX = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3' };
const THEME = { fg: (_color, text) => text, bold: (text) => text };
const PARAMS = { question: 'Which runner should the tests use?', options: [{ label: 'node:test' }, { label: 'vitest', description: 'Adds a dependency' }], recommended: 0 };

// A fake Pi: ctx.ui.custom builds the component and hands it to `onOpen`, which plays the user.
function setup({ runtime, env = IN_TMUX, mode = 'tui', onOpen = () => {}, beforeBuild = () => {} } = {}) {
  const tools = new Map();
  const events = new Map();
  const writes = [];
  let active = [];
  const signals = new EventEmitter();
  signals.on('SIGHUP', () => {});
  signals.on('SIGTERM', () => {});
  createWorkExtension({
    runtime: () => runtime,
    repoFromCwd: () => undefined,
    env,
    pid: 4242,
    tmux: (args) => (args[0] === 'display-message' ? 'api\n' : ''),
    git: () => { throw new Error('not a git repository'); },
    signals,
    write: (value) => writes.push(value),
    watchdog: () => () => {},
  })({
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
      if (['direct', 'model-only', undefined].includes(definition.exposure)) active.push(definition.name);
    },
    on(name, handler) { events.set(name, handler); },
    getActiveTools: () => [...active],
    getAllTools: () => [{ name: 'tool_search' }],
    setActiveTools(names) { active = [...names]; },
  });
  const ctx = {
    cwd: '/src/api',
    mode,
    hasUI: mode === 'tui',
    sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => null, getSessionName: () => undefined },
    ui: {
      notify() {},
      setStatus() {},
      custom: (factory) => new Promise((resolve) => {
        beforeBuild();
        const component = factory({ requestRender() {} }, THEME, undefined, resolve);
        onOpen(component);
      }),
    },
  };
  const emit = (name, event = {}) => events.get(name)(event, ctx);
  const ask = (params = PARAMS, signal) => tools.get('ask_user').execute('c1', params, signal, undefined, ctx);
  return { tools, emit, ask, ctx, writes, active: () => active };
}

const keys = (component, ...sequence) => { for (const key of sequence) component.handleInput(key); };

test('while the dialog is open the session is needs-me with the question, notifies, and shows in Decisions', async () => {
  const rt = await memoryRuntime();
  let seen;
  const s = setup({
    runtime: rt,
    onOpen: (component) => {
      seen = rt.store.getSession('sess-1');
      keys(component, 'j', '\r');
    },
  });
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  const result = await s.ask();
  assert.equal(seen.status, 'needs-me');
  assert.match(seen.note, /^Which runner should the tests use\? \[node:test \/ vitest\]$/);
  assert.equal(s.writes.length, 1);
  assert.match(s.writes[0], /Which runner should the tests use\?/);
  const model = buildDashModel({ sessions: [{ ...seen, liveness: 'live', itemId: null, itemTitle: null }], triageCount: 0, now: new Date(seen.statusAt) });
  const decisions = model.sections.find((section) => section.id === 'decisions').rows;
  assert.equal(decisions.length, 1);
  assert.match(rowCells(decisions[0], model.now, true).note, /Which runner.*node:test \/ vitest/);

  assert.equal(result.content[0].text, 'The user chose "vitest" (option index 1).');
  assert.deepEqual(result.details.answer, { kind: 'option', index: 1, label: 'vitest' });
  const after = rt.store.getSession('sess-1');
  assert.deepEqual([after.status, after.note], ['working', '']);
});

test('free text comes back as typed, and Esc dismisses without guessing; both clear the status', async () => {
  const rt = await memoryRuntime();
  let play;
  const s = setup({ runtime: rt, onOpen: (component) => play(component) });
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  play = (component) => keys(component, 'G', '\r', ...'jest', '\r');
  const typed = await s.ask();
  assert.equal(typed.content[0].text, 'The user answered in their own words: jest');
  play = (component) => keys(component, '\x1b');
  const dismissed = await s.ask();
  assert.equal(dismissed.content[0].text, ASK_USER_DISMISSED);
  assert.equal(rt.store.getSession('sess-1').status, 'working');
});

test('an answered question does not count as the turn declaration; settling falls back to the last line', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, onOpen: (component) => keys(component, '\r') });
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  await s.tools.get('session_status').execute('c0', { status: 'done', note: 'Early' }, undefined, undefined, s.ctx);
  await s.ask();
  await s.emit('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Using node:test. Ready to merge?' }] }] });
  await s.emit('agent_settled');
  const row = rt.store.getSession('sess-1');
  assert.deepEqual([row.status, row.note, row.statusSource], ['needs-me', 'Using node:test. Ready to merge?', 'auto']);
});

test('an aborted run closes the dialog as dismissed', async () => {
  const rt = await memoryRuntime();
  const controller = new AbortController();
  const s = setup({ runtime: rt, onOpen: () => controller.abort() });
  await s.emit('session_start', { reason: 'startup' });
  const result = await s.ask(PARAMS, controller.signal);
  assert.equal(result.content[0].text, ASK_USER_DISMISSED);
});

test('a run aborted before the dialog opens finishes as dismissed instead of leaving the dialog open', async () => {
  const rt = await memoryRuntime();
  const early = new AbortController();
  early.abort();
  const s = setup({ runtime: rt, onOpen: () => assert.fail('dialog opened') });
  await s.emit('session_start', { reason: 'startup' });
  const before = await s.ask(PARAMS, early.signal);
  assert.equal(before.content[0].text, ASK_USER_DISMISSED);
  assert.equal(s.writes.length, 0);
  assert.equal(rt.store.getSession('sess-1').status, 'needs-me');

  // Aborted after the status is set but before Pi builds the component: no abort event is left to fire.
  const late = new AbortController();
  const t = setup({ runtime: await memoryRuntime(), beforeBuild: () => late.abort() });
  await t.emit('session_start', { reason: 'startup' });
  const during = await Promise.race([t.ask(PARAMS, late.signal), new Promise((resolve) => setTimeout(() => resolve('still open'), 200))]);
  assert.equal(during.content?.[0].text, ASK_USER_DISMISSED);
});

test('a recommended index out of range is reported without opening the dialog', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, onOpen: () => assert.fail('dialog opened') });
  await s.emit('session_start', { reason: 'startup' });
  const result = await s.ask({ ...PARAMS, recommended: 5 });
  assert.equal(result.details.answer, null);
  assert.equal(rt.store.getSession('sess-1').status, 'needs-me');
  assert.equal(s.writes.length, 0);
});

test('ask_user is model-only in a terminal session, inactive without a TUI, and absent from child runs', async () => {
  const rt = await memoryRuntime();
  const tui = setup({ runtime: rt });
  assert.equal(tui.tools.get('ask_user').exposure, 'model-only');
  await tui.emit('session_start', { reason: 'startup' });
  assert.ok(tui.active().includes('ask_user'));

  const rpc = setup({ runtime: await memoryRuntime(), mode: 'rpc', onOpen: () => assert.fail('dialog opened') });
  await rpc.emit('session_start', { reason: 'startup' });
  assert.equal(rpc.active().includes('ask_user'), false);
  assert.ok(rpc.active().includes('session_status'));
  const result = await rpc.ask();
  assert.equal(result.content[0].text, ASK_USER_NO_UI);

  const child = setup({ runtime: rt, mode: 'rpc', env: { PI_WORK_CHILD_RUN: 'C-7' } });
  assert.equal(child.tools.has('ask_user'), false);
});
