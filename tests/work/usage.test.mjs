import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { captureIo, clock, DAY, load, memoryRuntime, memoryStore } from './helpers.mjs';

const usage = await load('src/work/usage.ts');
const { runCli } = await load('src/work/cli.ts');
const { parseWorkConfig, emptyConfig } = await load('src/work/config.ts');
const { createWorkExtension } = await load('extensions/work.ts');
const { handleTriageAction } = await load('src/work/triage-ui.ts');
const { registerPlannerTools } = await load('src/work/planner-tools.ts');
const { syncAll } = await load('src/work/sync.ts');
const { runDash } = await load('src/work/dash/app.ts');
const { plainStyle } = await load('src/work/dash/text.ts');

const rows = (store, surface) => store.listUsage().filter((row) => !surface || row.surface === surface).map((row) => [row.surface, row.action, row.context]);

test('contexts keep only numbers, booleans, and short enum-like strings', () => {
  assert.deepEqual(
    usage.sanitizeContext({ seconds: 12, ok: true, source: 'github', title: 'Fix the login bug', Bad: 1, nan: Number.NaN, nested: { a: 1 }, long: 'x'.repeat(50) }),
    { seconds: 12, ok: true, source: 'github' },
  );
});

test('recording honors "usage": false, ignores invalid actions, and never throws', async () => {
  const store = await memoryStore();
  usage.recordUsage({ store, config: { usage: false } }, 'cli', 'add');
  usage.recordUsage({ store, config: {} }, 'cli', 'Not An Action');
  usage.recordUsage({ store, config: {} }, 'cli', 'add', { exit: 0 });
  assert.deepEqual(rows(store), [['cli', 'add', { exit: 0 }]]);
  store.close();
  assert.doesNotThrow(() => usage.recordUsage({ store, config: {} }, 'cli', 'add'));
});

test('the config can turn usage off', () => {
  assert.equal(parseWorkConfig('{"usage": false}').config.usage, false);
  assert.equal(parseWorkConfig('{}').config.usage, undefined);
  assert.match(parseWorkConfig('{"usage": "no"}').warnings[0], /usage must be true or false/);
});

test('CLI commands are recorded with their exit code, and restore runs with counts', async () => {
  const rt = await memoryRuntime();
  const io = captureIo();
  const deps = { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, repoFromCwd: () => undefined, tmux: () => '', readers: { kill: () => { throw new Error('kill ESRCH'); }, environ: () => undefined }, bootId: () => 'b' };
  await runCli(['add', 'write', 'docs'], deps);
  await runCli(['set', 'W-9', 'status=done'], deps);
  await runCli(['restore', '--dry-run'], deps);
  assert.deepEqual(rows(rt.store), [
    ['cli', 'add', { exit: 0 }],
    ['cli', 'set', { exit: 1 }],
    ['cli', 'restore.run', { mode: 'dry-run', ran: false, placed: 0, skipped: 0, failed: 0 }],
    ['cli', 'restore', { exit: 0 }],
  ]);
});

test('Pi commands and needs-me response times are recorded without content', async () => {
  const now = clock();
  const rt = await memoryRuntime({ now });
  const commands = new Map();
  const events = new Map();
  createWorkExtension({ runtime: () => rt, repoFromCwd: () => undefined, env: { TMUX: 't', TMUX_PANE: '%1' }, pid: 1, tmux: () => 'api\n', git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter(), write: () => {} })({
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool() {},
    on(name, handler) { events.set(name, handler); },
    getAllTools: () => [{ name: 'tool_search' }],
    getActiveTools: () => [],
    setActiveTools() {},
  });
  const ctx = { cwd: '/src/api', mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 's1', getSessionFile: () => undefined, getSessionName: () => undefined }, ui: { notify() {}, setStatus() {} } };
  await commands.get('todo')('secret title', ctx);
  await events.get('session_start')({ reason: 'startup' }, ctx);
  await events.get('agent_start')({}, ctx);
  await events.get('agent_end')({ messages: [] }, ctx);
  await events.get('agent_settled')({}, ctx);
  now.advance(90_000);
  await events.get('input')({ text: '/todo x', source: 'interactive' }, ctx);
  await events.get('input')({ text: 'queued', source: 'extension' }, ctx);
  await events.get('input')({ text: 'yes, trim it', source: 'interactive' }, ctx);
  assert.deepEqual(rows(rt.store), [['pi', 'todo', {}], ['pi', 'session.responded', { seconds: 90 }]]);
  assert.equal(JSON.stringify(rt.store.listUsage()).includes('secret'), false);
});

test('triage outcomes are recorded by source and kind, only when they happen', async () => {
  const rt = await memoryRuntime();
  const ctx = { ui: { notify() {}, input: async () => undefined, select: async () => undefined, confirm: async () => false, custom: async () => undefined } };
  const dismissed = rt.store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k1', title: 'T', reason: 'r' }, 'sync:github');
  await handleTriageAction(ctx, rt, 'd', dismissed);
  const cancelled = rt.store.addCandidate({ kind: 'new-item', source: 'agent', dedupeKey: 'k2', title: 'T2', reason: 'r' }, 'agent:s');
  await handleTriageAction(ctx, rt, 'a', cancelled);
  assert.deepEqual(rows(rt.store), [['triage', 'dismiss', { source: 'github', kind: 'new-item' }]]);
});

test('saving a plan records how many of the previous focus items saw activity', async () => {
  const now = clock();
  const rt = await memoryRuntime({ now });
  const [a, b, c] = ['A', 'B', 'C'].map((title) => rt.store.addItem({ project: 'misc', title, origin: 'manual' }, 'user'));
  now.advance(1000);
  rt.store.savePlan({ date: '2026-09-24', itemIds: [a.id, b.id, c.id], quickActions: [], notes: '' }, 'planner');
  now.advance(60_000);
  rt.store.updateItem(a.id, { status: 'doing' }, 'user');
  now.advance(DAY);
  const tools = new Map();
  registerPlannerTools({ registerTool(definition) { tools.set(definition.name, definition); } }, () => rt);
  await tools.get('work_plan_save').execute('c1', { focus: [b.id], quick_actions: [] });
  assert.deepEqual(rows(rt.store, 'planner'), [['planner', 'save', { focus: 1, prev_focus: 3, followed: 1 }]]);
});

test('dashboard actions are recorded, and navigation is summarized when it closes', async () => {
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 's1', file: null, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  let input = () => {};
  const terminal = { columns: () => 80, rows: () => 24, write() {}, onInput(handler) { input = handler; }, onResize() {}, start() {}, stop() {} };
  const result = runDash({
    runtime: rt, terminal, tmux: (args) => (args[0] === 'list-panes' ? '%1\t@1\tapi\tmain\t/src/api\tnode' : ''), insideTmux: true,
    readers: { kill: () => {}, environ: () => undefined }, style: plainStyle, refreshMs: 0, bootId: () => 'b',
  });
  for (const key of ['j', 'k', '/', '\x1b', '\r']) input(key);
  await result;
  const dash = rows(rt.store, 'dash');
  assert.deepEqual(dash.map(([, action]) => action), ['open', 'filter', 'jump', 'close']);
  assert.equal(dash.at(-1)[2].moves, 2);
});

test('sync deletes usage rows older than 180 days', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.recordUsage('cli', 'old', {});
  now.advance(181 * DAY);
  store.recordUsage('cli', 'new', {});
  await syncAll(store, emptyConfig(), {});
  assert.deepEqual(store.listUsage().map((row) => row.action), ['new']);
});
