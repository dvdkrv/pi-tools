import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, DAY, load, memoryStore } from './helpers.mjs';

const { renderRecap, recapRange } = await load('src/work/recap.ts');

test('recap renders done, progressed, new, and waiting sections from events', async () => {
  const now = clock('2026-09-24T12:00:00.000Z');
  const store = await memoryStore(now);
  const old = store.addItem({ project: 'misc', title: 'Old task', origin: 'manual' }, 'user');
  const moving = store.addItem({ project: 'misc', title: 'Moving task', origin: 'manual' }, 'user');
  const waiting = store.addItem({ project: 'misc', title: 'Blocked task', origin: 'manual' }, 'user');
  store.updateItem(waiting.id, { status: 'waiting', waitingOn: 'review', waitingReason: 'PR 9' }, 'user');
  now.set('2026-09-25T10:00:00.000Z');
  store.updateItem(old.id, { status: 'done' }, 'user');
  store.updateItem(moving.id, { notes: 'progress' }, 'user');
  store.addItem({ project: 'misc', title: 'Fresh task', origin: 'manual' }, 'user');
  now.advance(DAY / 4);

  const range = { from: '2026-09-25T00:00:00.000Z', to: now().toISOString(), label: '2026-09-25' };
  assert.equal(renderRecap(store, range, now()), [
    '## Work recap: 2026-09-25',
    '',
    '### Done',
    '- W-1 Old task (#misc)',
    '',
    '### Progressed',
    '- W-2 Moving task (#misc)',
    '',
    '### New',
    '- W-4 Fresh task (#misc)',
    '',
    '### Waiting on others',
    '- W-3 Blocked task (#misc): review for 1 day: PR 9',
    '',
  ].join('\n'));
});

test('recapRange covers today, yesterday, and the last seven days', () => {
  const now = new Date(2026, 8, 25, 15, 0, 0);
  const today = recapRange('today', now);
  assert.equal(today.label, '2026-09-25');
  assert.equal(today.from, new Date(2026, 8, 25).toISOString());
  const yesterday = recapRange('yesterday', now);
  assert.equal(yesterday.label, '2026-09-24');
  assert.equal(yesterday.to, new Date(2026, 8, 25).toISOString());
  assert.equal(recapRange('week', now).label, '2026-09-19 to 2026-09-25');
});
