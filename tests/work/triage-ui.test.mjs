import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryRuntime } from './helpers.mjs';
import { NAVIGATION } from './fixtures/keymap-table.mjs';

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

function listHarness(count) {
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: i + 1, kind: 'new-item', source: 'github', title: `Candidate ${i}`, reason: 'r', evidence: null, relatesTo: null, proposedProject: 'misc', payload: {},
  }));
  let component;
  const ctx = {
    ui: {
      custom: (factory) => new Promise((resolve) => {
        component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, null, resolve);
      }),
    },
  };
  const result = ui.triageList(ctx, candidates);
  return { press: (...keys) => { for (const key of keys) component.handleInput(key); }, result };
}

for (const entry of NAVIGATION) {
  test(`/triage keys: ${entry.name}`, async () => {
    const h = listHarness(20);
    h.press('j', 'j', 'j', 'j', 'j', ...entry.keys, '\r');
    const result = await h.result;
    assert.equal(result.key, 'enter');
    assert.equal(result.candidate.id, entry.list + 1);
  });
}

test('/triage keeps its action letters and closes with Esc or q', async () => {
  const accept = listHarness(3);
  accept.press('j', 'A');
  assert.deepEqual(await accept.result.then((r) => [r.key, r.candidate.id]), ['A', 2]);
  const esc = listHarness(3);
  esc.press('\x1b');
  assert.deepEqual(await esc.result, { type: 'cancel' });
  const q = listHarness(3);
  q.press('q');
  assert.deepEqual(await q.result, { type: 'cancel' });
});
