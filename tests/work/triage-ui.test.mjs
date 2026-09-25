import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryRuntime } from './helpers.mjs';

const ui = await load('src/work/triage-ui.ts');

function fakeCtx({ inputs = [], selects = [], confirms = [] } = {}) {
  const notes = [];
  return {
    ctx: {
      ui: {
        input: async () => inputs.shift(),
        select: async (_title, options) => { const pick = selects.shift(); return typeof pick === 'number' ? options[pick] : pick; },
        confirm: async () => confirms.shift() ?? false,
        notify: (message, level) => notes.push({ message, level }),
        custom: async () => { throw new Error('custom UI not expected in this test'); },
      },
    },
    notes,
  };
}

const newCandidate = (rt, n) => rt.store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: `k${n}`, title: `Review ${n}`, reason: 'r', proposedProject: 'misc' }, 'sync:github');

test('keys map to triage actions', () => {
  assert.equal(ui.triageKeyFor('a'), 'a');
  assert.equal(ui.triageKeyFor('A'), 'A');
  assert.equal(ui.triageKeyFor('\r'), 'enter');
  assert.equal(ui.triageKeyFor('x'), undefined);
});

test('accept asks for title and project, and cancelling the title changes nothing', async () => {
  const rt = await memoryRuntime();
  const c1 = newCandidate(rt, 1);
  const cancelled = fakeCtx({ inputs: [undefined] });
  await ui.handleTriageAction(cancelled.ctx, rt, 'a', c1);
  assert.equal(rt.store.listItems().length, 0);
  const accepted = fakeCtx({ inputs: ['Renamed'], selects: [0] });
  await ui.handleTriageAction(accepted.ctx, rt, 'a', c1);
  assert.equal(rt.store.listItems()[0].title, 'Renamed');
});

test('dismiss, snooze default, and details', async () => {
  const rt = await memoryRuntime();
  const a = newCandidate(rt, 1);
  const b = newCandidate(rt, 2);
  const f = fakeCtx({ inputs: [''] });
  await ui.handleTriageAction(f.ctx, rt, 'd', a);
  assert.equal(rt.store.isDismissed('k1'), true);
  await ui.handleTriageAction(f.ctx, rt, 'z', b);
  assert.equal(rt.store.getCandidate(b.id).state, 'snoozed');
  await ui.handleTriageAction(f.ctx, rt, 'enter', rt.store.getCandidate(b.id));
  assert.match(f.notes.at(-1).message, /\[github\] Review 2/);
});

test('promote without Jira reports a clear error', async () => {
  const rt = await memoryRuntime();
  const c = newCandidate(rt, 1);
  const f = fakeCtx({ inputs: [''], selects: [0] });
  await assert.rejects(ui.handleTriageAction(f.ctx, rt, 'p', c), /Jira is not configured/);
  assert.equal(rt.store.listItems().length, 1);
});
