import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, DAY, load, memoryStore, tempDir } from './helpers.mjs';

const run = promisify(execFile);
const { WorkStore } = await load('src/work/store.ts');

const eventCount = (store) => store.listEvents().length;

test('opening an empty database applies migrations and creates misc', async () => {
  const store = await memoryStore();
  assert.deepEqual(store.listProjects().map((p) => p.slug), ['misc']);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
});

test('a database with a newer schema is refused and left unmodified', () => {
  const path = join(tempDir(), 'work.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => WorkStore.open(path), /newer/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0);
  check.close();
});

test('each item mutation writes exactly one event, and no-ops write none', async () => {
  const store = await memoryStore();
  const item = store.addItem({ project: 'misc', title: 'Write the plan', origin: 'manual' }, 'user');
  assert.equal(item.id, 'W-1');
  assert.equal(eventCount(store), 1);
  store.updateItem(item.id, { status: 'doing' }, 'user');
  assert.equal(eventCount(store), 2);
  store.upsertProject({ slug: 'misc', title: 'Misc' }, 'user');
  assert.equal(eventCount(store), 2);
  const [created, updated] = store.listEvents();
  assert.equal(created.entity, 'item:W-1');
  assert.equal(created.action, 'create');
  assert.equal(updated.data.before.status, 'todo');
  assert.equal(updated.data.after.status, 'doing');
});

test('waiting requires waiting_on, records since, and clears on exit', async () => {
  const now = clock();
  const store = await memoryStore(now);
  const item = store.addItem({ project: 'misc', title: 'Review', origin: 'manual' }, 'user');
  assert.throws(() => store.updateItem(item.id, { status: 'waiting' }, 'user'), /waiting_on/);
  const waiting = store.updateItem(item.id, { status: 'waiting', waitingOn: 'review', waitingReason: 'PR 42' }, 'user');
  assert.equal(waiting.waitingSince, '2026-09-25T09:00:00.000Z');
  now.advance(DAY);
  const still = store.updateItem(item.id, { waitingReason: 'PR 42 round 2' }, 'user');
  assert.equal(still.waitingSince, '2026-09-25T09:00:00.000Z');
  const done = store.updateItem(item.id, { status: 'done' }, 'user');
  assert.equal(done.waitingOn, null);
  assert.equal(done.waitingSince, null);
  assert.throws(() => store.updateItem(item.id, { waitingOn: 'ci' }, 'user'), /only valid/);
});

test('link keys are unique and unchanged state writes no event', async () => {
  const store = await memoryStore();
  const item = store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const link = store.addLink(item.id, { kind: 'jira', key: 'jira:ABC-1', url: 'https://example.atlassian.net/browse/ABC-1' }, 'user');
  assert.throws(() => store.addLink(item.id, { kind: 'jira', key: 'jira:ABC-1' }, 'user'), /already belongs/);
  store.updateLinkState(link.id, { status: 'Open' }, 'sync:jira');
  const before = eventCount(store);
  store.updateLinkState(link.id, { status: 'Open' }, 'sync:jira');
  assert.equal(eventCount(store), before);
  assert.deepEqual(store.findLinkByKey('jira:ABC-1').state, { status: 'Open' });
});

test('open candidates are unique per dedupe key', async () => {
  const store = await memoryStore();
  const c = store.addCandidate({ kind: 'new-item', source: 'github', query: 'q', dedupeKey: 'k', title: 'T', reason: 'R' }, 'sync:github');
  assert.equal(store.findOpenCandidate('k').id, c.id);
  assert.throws(() => store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k', title: 'T', reason: 'R' }, 'sync:github'));
  store.updateCandidate(c.id, { state: 'dismissed' }, 'user');
  assert.equal(store.findOpenCandidate('k'), undefined);
  assert.equal(store.getCandidate(c.id).resolvedAt, '2026-09-25T09:00:00.000Z');
});

test('plans, dismissals, meta, and connector runs round-trip', async () => {
  const store = await memoryStore();
  store.savePlan({ date: '2026-09-24', itemIds: ['W-1'], quickActions: ['reply'], notes: '' }, 'planner');
  assert.equal(store.latestPlanBefore('2026-09-25').date, '2026-09-24');
  store.addDismissal('k', 'user');
  assert.equal(store.isDismissed('k'), true);
  assert.equal(store.removeDismissal('k', 'user'), true);
  store.setMeta('a', '1');
  assert.equal(store.getMeta('a'), '1');
  store.recordConnectorRun({ connector: 'jira', query: 'assigned-open', status: 'ok', error: null });
  store.recordConnectorRun({ connector: 'jira', query: 'assigned-open', status: 'auth-failed', error: 'nope' });
  const [run1] = store.listConnectorRuns();
  assert.equal(run1.status, 'auth-failed');
  assert.equal(run1.lastOkAt, '2026-09-25T09:00:00.000Z');
});

test('concurrent writers in separate processes lose no writes', async () => {
  const path = join(tempDir(), 'work.db');
  WorkStore.open(path).close();
  const writer = new URL('./fixtures/concurrent-writer.mjs', import.meta.url).pathname;
  await Promise.all([1, 2, 3, 4].map(() => run(process.execPath, [writer, path, '25'])));
  const store = WorkStore.open(path);
  assert.equal(store.listItems().length, 100);
  assert.equal(store.listEvents().length, 100);
  store.close();
});
