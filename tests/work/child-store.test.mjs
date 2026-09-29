import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { WorkStore } = await load('src/work/store.ts');
const { MIGRATIONS } = await load('src/work/migrations.ts');

const brief = (overrides = {}) => ({ goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null, ...overrides });
const input = (overrides = {}) => ({ leadSession: 'lead-1', brief: brief(), model: 'anthropic/claude-sonnet-5', repo: 'api', budgetLines: 300, budgetFiles: 8, ...overrides });
const tree = (id) => ({ worktree: `/src/api/.pi/worktrees/child-${id}`, branch: `child/feat/${id}`, baseCommit: 'abc123' });

test('createChildRun records a running run with its worktree and one create event', async () => {
  const store = await memoryStore();
  const run = store.createChildRun(input(), 'session:lead-1', tree);
  assert.equal(run.id, 'C-1');
  assert.equal(run.outcome, 'running');
  assert.equal(run.kind, 'implement');
  assert.deepEqual([run.worktree, run.branch, run.baseCommit], ['/src/api/.pi/worktrees/child-C-1', 'child/feat/C-1', 'abc123']);
  assert.deepEqual(run.brief, brief());
  assert.deepEqual([run.flags, run.spendUsd, run.acceptance, run.summary], [[], 0, [], '']);
  assert.equal(run.createdAt, '2026-09-25T09:00:00.000Z');
  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].entity, events[0].action, events[0].actor], ['child:C-1', 'create', 'session:lead-1']);
  assert.equal(events[0].data.after.worktree, '/src/api/.pi/worktrees/child-C-1');
});

test('a failing prepare records no run and no event, and read-only runs need no worktree', async () => {
  const store = await memoryStore();
  assert.throws(() => store.createChildRun(input(), 'session:lead-1', () => { throw new Error('worktree add failed'); }), /worktree add failed/);
  assert.deepEqual(store.listChildRuns(), []);
  assert.deepEqual(store.listEvents(), []);
  const readOnly = store.createChildRun(input({ brief: brief({ kind: 'read-only', scope: [], acceptance: [] }), budgetLines: null, budgetFiles: null }), 'session:lead-1');
  assert.equal(readOnly.kind, 'read-only');
  assert.deepEqual([readOnly.worktree, readOnly.budgetLines], [null, null]);
});

test('progress updates are operational and write no events', async () => {
  const store = await memoryStore();
  store.createChildRun(input(), 'session:lead-1', tree);
  const before = store.listEvents().length;
  const run = store.updateChildRun('C-1', { childSession: 'child-s', pid: 4321, flags: ['over-budget'], spendUsd: 1.25, diffLines: 212, diffFiles: 3 });
  assert.deepEqual([run.childSession, run.pid, run.flags, run.spendUsd, run.diffLines, run.diffFiles], ['child-s', 4321, ['over-budget'], 1.25, 212, 3]);
  assert.equal(store.childRunForSession('child-s').id, 'C-1');
  assert.equal(store.childRunForSession('nope'), undefined);
  assert.equal(store.listEvents().length, before);
  assert.throws(() => store.updateChildRun('C-9', { pid: 1 }), /Unknown child run: C-9/);
  assert.throws(() => store.getChildRun('W-1'), /Invalid child run ID/);
});

test('endChildRun ends a running run once, and later calls change nothing', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.createChildRun(input(), 'session:lead-1', tree);
  now.advance(60_000);
  const acceptance = [{ command: 'node --test tests/a.test.mjs', exitCode: 0, summary: 'pass 3' }];
  const ended = store.endChildRun('C-1', { outcome: 'done', summary: 'Added retry', acceptance, diffLines: 40, diffFiles: 2 }, 'session:lead-1');
  assert.deepEqual([ended.outcome, ended.summary, ended.diffLines, ended.diffFiles], ['done', 'Added retry', 40, 2]);
  assert.deepEqual(ended.acceptance, acceptance);
  assert.equal(ended.endedAt, '2026-09-25T09:01:00.000Z');
  const count = store.listEvents().length;
  assert.equal(store.endChildRun('C-1', { outcome: 'stopped' }, 'user').outcome, 'done');
  assert.equal(store.listEvents().length, count);
  assert.equal(store.listEvents().at(-1).action, 'end');
});

test('only done runs merge, ended runs can be discarded, and lists filter by lead and outcome', async () => {
  const store = await memoryStore();
  store.createChildRun(input(), 'session:lead-1', tree);
  store.createChildRun(input(), 'session:lead-1', tree);
  store.createChildRun(input({ leadSession: 'lead-2' }), 'session:lead-2', tree);
  assert.throws(() => store.markChildRunMerged('C-1', 'session:lead-1'), /C-1 is running, not done/);
  assert.throws(() => store.markChildRunDiscarded('C-1', 'session:lead-1'), /C-1 is running and cannot be discarded/);
  store.endChildRun('C-1', { outcome: 'done' }, 'session:lead-1');
  const merged = store.markChildRunMerged('C-1', 'session:lead-1');
  assert.deepEqual([merged.outcome, merged.mergedAt], ['merged', '2026-09-25T09:00:00.000Z']);
  assert.throws(() => store.markChildRunDiscarded('C-1', 'session:lead-1'), /C-1 is merged and cannot be discarded/);
  store.endChildRun('C-2', { outcome: 'interrupted' }, 'session:lead-1');
  assert.equal(store.markChildRunDiscarded('C-2', 'session:lead-1').outcome, 'discarded');
  assert.deepEqual(store.listEvents().map((event) => `${event.entity} ${event.action}`), [
    'child:C-1 create', 'child:C-2 create', 'child:C-3 create', 'child:C-1 end', 'child:C-1 merge', 'child:C-2 end', 'child:C-2 discard',
  ]);
  assert.deepEqual(store.listChildRuns({ leadSession: 'lead-1' }).map((run) => run.id), ['C-1', 'C-2']);
  assert.deepEqual(store.listChildRuns({ outcome: 'running' }).map((run) => run.id), ['C-3']);
});

test('a version 2 database migrates to version 3, and backups carry child runs', () => {
  const path = join(tempDir(), 'work.db');
  const raw = new DatabaseSync(path);
  raw.exec(MIGRATIONS[0]);
  raw.exec(MIGRATIONS[1]);
  raw.exec('PRAGMA user_version = 2');
  raw.close();
  const store = WorkStore.open(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.isEmpty(), true);
  store.createChildRun(input(), 'session:lead-1', tree);
  assert.equal(store.dumpTables().child_run.length, 1);
  assert.equal(store.isEmpty(), false);
  store.close();
});
