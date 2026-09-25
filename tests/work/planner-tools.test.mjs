import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryRuntime } from './helpers.mjs';

const { registerPlannerTools } = await load('src/work/planner-tools.ts');
const { createWorkExtension } = await load('extensions/work.ts');
const { localDate } = await load('src/work/capture.ts');

async function tools() {
  const rt = await memoryRuntime();
  const registered = new Map();
  registerPlannerTools({ registerTool: (definition) => registered.set(definition.name, definition) }, () => rt);
  const call = async (name, params) => {
    const result = await registered.get(name).execute('id', params, undefined, undefined, {});
    return JSON.parse(result.content[0].text);
  };
  return { rt, registered, call };
}

test('registers exactly the four planner tools', async () => {
  const { registered } = await tools();
  assert.deepEqual([...registered.keys()].sort(), ['work_item', 'work_plan_save', 'work_snapshot', 'work_update']);
});

test('work_snapshot and work_item return delimited JSON', async () => {
  const { rt, call } = await tools();
  rt.store.addItem({ project: 'misc', title: 'Plan the day', notes: 'n', origin: 'manual' }, 'user');
  const snap = await call('work_snapshot', {});
  assert.equal(snap.projects[0].items[0].external_title, 'Plan the day');
  const item = await call('work_item', { id: 'W-1' });
  assert.equal(item.external_notes, 'n');
  assert.equal(item.events[0].action, 'create');
});

test('work_update applies local changes as the planner and validates input', async () => {
  const { rt, call, registered } = await tools();
  rt.store.addItem({ project: 'misc', title: 'x', origin: 'manual' }, 'user');
  const updated = await call('work_update', { id: 'W-1', status: 'waiting', waiting_on: 'review', waiting_reason: 'PR 4', pinned: true });
  assert.equal(updated.status, 'waiting');
  assert.equal(rt.store.listEvents().at(-1).actor, 'planner');
  const due = await call('work_update', { id: 'W-1', due: 'tomorrow' });
  assert.match(due.due, /^\d{4}-\d{2}-\d{2}$/);
  const cleared = await call('work_update', { id: 'W-1', due: '' });
  assert.equal(cleared.due, null);
  await assert.rejects(registered.get('work_update').execute('id', { id: 'W-9', status: 'done' }, undefined, undefined, {}), /Unknown item/);
});

test('work_plan_save saves today and marks focus signals seen', async () => {
  const { rt, call, registered } = await tools();
  const item = rt.store.addItem({ project: 'misc', title: 'x', origin: 'manual' }, 'user');
  const link = rt.store.addLink(item.id, { kind: 'url', key: 'url:u' }, 'user');
  rt.store.addSignal({ itemId: item.id, linkId: link.id, kind: 'comments-new', detail: '1 new comment' }, 'sync:github');
  const plan = await call('work_plan_save', { focus: ['W-1'], quick_actions: ['Reply on W-1'], notes: 'ok' });
  assert.equal(plan.date, localDate(rt.store.clock()));
  assert.equal(rt.store.listSignals({ unseenOnly: true }).length, 0);
  await assert.rejects(registered.get('work_plan_save').execute('id', { focus: ['W-9'], quick_actions: [] }, undefined, undefined, {}), /Unknown item W-9/);
});

test('the extension registers planner tools only with PI_WORK_PLANNER=1, and /today launches the planner', async () => {
  const rt = await memoryRuntime();
  const register = (env, tmux) => {
    const commands = new Map();
    const registered = new Map();
    createWorkExtension({ runtime: () => rt, repoFromCwd: () => undefined, env, tmux })({
      registerCommand: (name, definition) => commands.set(name, definition.handler),
      registerTool: (definition) => registered.set(definition.name, definition),
      on: () => {},
    });
    return { commands, registered };
  };
  assert.equal(register({}).registered.has('work_snapshot'), false);
  assert.equal(register({ PI_WORK_PLANNER: '1' }).registered.has('work_snapshot'), true);

  const calls = [];
  const tmux = (args) => { calls.push(args); return args[0] === 'new-window' ? '@9' : ''; };
  const { commands } = register({ TMUX: '1' }, tmux);
  const notes = [];
  await commands.get('today')('', { mode: 'print', cwd: '/', ui: { notify: (m, l) => notes.push({ m, l }), setStatus: () => {} } });
  assert.match(notes.at(-1).m, /Started planner session plan-/);
  assert.ok(calls.some((c) => c[0] === 'new-window'));
});
