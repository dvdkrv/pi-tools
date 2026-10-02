import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, memoryRuntime, tempDir, until } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');
const FAKE = fileURLToPath(new URL('./fixtures/fake-rpc-child.mjs', import.meta.url));
const READ_ONLY = { goal: 'Map the auth flow', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };

function setup({ runtime, env = {}, mode = 'tui', supervisor = {}, toolSearch = true, idle }) {
  const tools = new Map();
  const events = new Map();
  const sent = [];
  let active;
  if (toolSearch) tools.set('tool_search', { name: 'tool_search', exposure: 'direct' });
  createWorkExtension({
    runtime: () => runtime, repoFromCwd: () => undefined, env, pid: 4242, tmux: () => '',
    git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter(), supervisor,
  })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
    sendMessage(message, options) { sent.push({ message, options }); },
    getActiveTools: () => active ?? [...tools.values()].filter((tool) => tool.name !== 'tool_search' && (tool.exposure ?? 'direct') === 'direct').map((tool) => tool.name),
    getAllTools: () => [...tools.values()],
    setActiveTools(names) { active = names; },
  });
  const notes = [];
  const ctx = {
    cwd: tempDir(), mode, hasUI: true,
    sessionManager: { getSessionId: () => 'lead-1', getSessionFile: () => undefined, getSessionName: () => undefined },
    ui: { notify: (message, level) => notes.push({ message, level }), setStatus() {} },
    abort() {}, shutdown() {},
    ...(idle ? { isIdle: () => idle.value } : {}),
  };
  const run = (name, params) => tools.get(name).execute('call-1', params, undefined, undefined, ctx);
  return { tools, sent, notes, ctx, run, active: () => active, emit: (name, event = {}) => events.get(name)(event, ctx) };
}

test('a lead gets five static delegation tools, and a child gets none', async () => {
  const lead = setup({ runtime: await memoryRuntime() });
  for (const name of ['delegate', 'children', 'steer_child', 'stop_child', 'merge_child']) assert.ok(lead.tools.has(name), name);
  assert.deepEqual(Object.keys(lead.tools.get('delegate').parameters.properties).sort(), ['acceptance', 'budget', 'context', 'from', 'goal', 'kind', 'model', 'model_reason', 'non_goals', 'repo', 'scope']);
  assert.equal(lead.tools.get('delegate').parameters.properties.repo.description, 'Absolute path to a git repository; the child runs there instead of the lead cwd.');
  const child = setup({ runtime: await memoryRuntime(), env: { PI_WORK_CHILD_RUN: 'C-1' }, mode: 'rpc' });
  assert.equal([...child.tools.keys()].some((name) => ['delegate', 'children', 'steer_child', 'stop_child', 'merge_child'].includes(name)), false);
});

test('lead, propose, and job tools are deferred with annotations; session_status stays direct', async () => {
  const s = setup({ runtime: await memoryRuntime() });
  for (const name of ['delegate', 'children', 'steer_child', 'stop_child', 'merge_child', 'work_propose', 'job_register']) assert.equal(s.tools.get(name).exposure, 'deferred', name);
  assert.equal(s.tools.get('session_status').exposure, undefined);
  assert.deepEqual(s.tools.get('children').annotations, { readOnlyHint: true });
  assert.deepEqual(s.tools.get('stop_child').annotations, { destructiveHint: true });
  assert.deepEqual(s.tools.get('merge_child').annotations, { destructiveHint: true });
});

test('a TUI lead activates tool_search so it can load the deferred tools', async () => {
  const s = setup({ runtime: await memoryRuntime() });
  await s.emit('session_start', { reason: 'startup' });
  assert.ok(s.active().includes('tool_search'));
  assert.ok(s.active().includes('session_status'));
  assert.equal(s.active().includes('delegate'), false);
});

test('a TUI lead without tool_search warns that the deferred tools cannot be called', async () => {
  const s = setup({ runtime: await memoryRuntime(), toolSearch: false });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(s.active(), undefined);
  assert.ok(s.notes.some((note) => note.level === 'warning' && /tool_search/.test(note.message)));
});

test('a non-TUI top-level session leaves the active tools alone', async () => {
  const s = setup({ runtime: await memoryRuntime(), mode: 'rpc' });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(s.active(), undefined);
});

test('a TUI lead start shows children config warnings and reports interrupted runs once', async () => {
  const rt = await memoryRuntime();
  rt.warnings.push('children.spendCapUsd must be a positive number; using 5', 'jira config needs an https site, email, secret.command, and defaultProject; Jira is disabled');
  rt.store.createChildRun({ leadSession: 'lead-1', brief: READ_ONLY, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:lead-1');
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(rt.store.getChildRun('C-1').outcome, 'interrupted');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].message.customType, 'work-child');
  assert.match(s.sent[0].message.content, /^These child runs were interrupted[\s\S]*- C-1 \(read-only\): Map the auth flow/);
  assert.deepEqual(s.sent[0].options, { deliverAs: 'followUp', triggerTurn: true });
  assert.deepEqual(s.notes.filter((note) => note.level === 'warning').map((note) => note.message), ['children.spendCapUsd must be a positive number; using 5']);
});

test('delegate, children, stop_child, and merge_child work end to end with a fake child', async () => {
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 'child-s1', file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: 'lead-1', headless: true });
  rt.store.setSessionStatus('child-s1', 'done', 'Found it', 'agent');
  const log = join(tempDir(), 'child.jsonl');
  const s = setup({
    runtime: rt,
    supervisor: { command: [process.execPath, FAKE], env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify({ sessionId: 'child-s1' }), FAKE_CHILD_LOG: log }, killGraceMs: 200 },
  });
  const started = await s.run('delegate', { goal: 'Map the auth flow', kind: 'read-only' });
  assert.match(started.content[0].text, /^Started C-1 \(read-only, in your working directory\)/);
  assert.equal(started.details.runId, 'C-1');
  await until(() => s.sent.length === 1);
  assert.match(s.sent[0].message.content, /^Child C-1 finished: done/);
  assert.deepEqual(s.sent[0].options, { deliverAs: 'followUp', triggerTurn: true });
  assert.match((await s.run('children', {})).content[0].text, /^C-1  done  gpt-5.6-sol  \$0\.00  read-only  goal: Map the auth flow  note: Found it$/);
  assert.equal((await s.run('merge_child', { id: 'C-1' })).content[0].text, 'Refused: C-1 is not one of your implement runs.');
  assert.equal((await s.run('stop_child', { id: 'C-1', discard: true })).content[0].text, 'Discarded C-1.');
  assert.match((await s.run('steer_child', { id: 'C-1', text: 'hi' })).content[0].text, /can no longer be steered/);
});

test('a child result triggers a turn only when the lead is idle; a busy lead gets it as context for its next request', async () => {
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 'child-s1', file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: 'lead-1', headless: true });
  rt.store.setSessionStatus('child-s1', 'done', 'Found it', 'agent');
  const idle = { value: false };
  const s = setup({
    runtime: rt, idle,
    supervisor: { command: [process.execPath, FAKE], env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify({ sessionId: 'child-s1' }), FAKE_CHILD_LOG: join(tempDir(), 'child.jsonl') }, killGraceMs: 200 },
  });
  await s.emit('session_start', { reason: 'startup' });
  await s.run('delegate', { goal: 'Map the auth flow', kind: 'read-only' });
  await until(() => s.sent.length === 1);
  assert.match(s.sent[0].message.content, /^Child C-1 finished: done/);
  assert.deepEqual(s.sent[0].options, { deliverAs: 'followUp', triggerTurn: false });
  idle.value = true;
  await s.run('delegate', { goal: 'Map the auth flow again', kind: 'read-only' });
  await until(() => s.sent.length === 2);
  assert.match(s.sent[1].message.content, /^Child C-2 finished: done/);
  assert.deepEqual(s.sent[1].options, { deliverAs: 'followUp', triggerTurn: true });
});

// A busy lead's result waits for its next request; if that request never comes, settle asks once.
async function busyLead(behavior) {
  const rt = await memoryRuntime();
  const idle = { value: false };
  const s = setup({
    runtime: rt, idle,
    supervisor: { command: [process.execPath, FAKE], env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify({ sessionId: 'child-s1', ...behavior }), FAKE_CHILD_LOG: join(tempDir(), 'child.jsonl') }, killGraceMs: 200 },
  });
  await s.emit('session_start', { reason: 'startup' });
  await s.run('delegate', { goal: 'Map the auth flow', kind: 'read-only' });
  await until(() => s.sent.length === 1);
  assert.deepEqual(s.sent[0].options, { deliverAs: 'followUp', triggerTurn: false });
  idle.value = true;
  return { rt, s };
}

test('a result a busy lead has not handled by settle triggers exactly one combined turn', async () => {
  const { s } = await busyLead({ onPrompt: 'exit' });
  assert.match(s.sent[0].message.content, /^Child C-1 finished: failed/);
  await s.emit('agent_settled');
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1].message.customType, 'work-child');
  assert.equal(s.sent[1].message.content, 'Child results that arrived while you were busy and are not handled yet: C-1 failed. Act on them or tell the user.');
  assert.deepEqual(s.sent[1].options, { deliverAs: 'followUp', triggerTurn: true });
  await s.emit('agent_settled');
  assert.equal(s.sent.length, 2);
});

test('a result a busy lead handled before settle triggers no turn', async () => {
  const { s } = await busyLead({ onPrompt: 'exit' });
  assert.equal((await s.run('stop_child', { id: 'C-1', discard: true })).content[0].text, 'Discarded C-1.');
  await s.emit('agent_settled');
  assert.equal(s.sent.length, 1);
});
