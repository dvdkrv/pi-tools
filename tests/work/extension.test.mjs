import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryRuntime } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');

function setup(runtime, env = {}) {
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  createWorkExtension({ runtime: () => runtime, repoFromCwd: () => 'payments-api', env })({
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
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
      sessionManager: { getSessionId: () => 'session-1' },
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
