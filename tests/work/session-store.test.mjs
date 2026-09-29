import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { WorkStore } = await load('src/work/store.ts');
const { MIGRATIONS } = await load('src/work/migrations.ts');

const start = (overrides = {}) => ({
  id: 's1', file: '/s/s1.jsonl', cwd: '/src/api', name: null, pid: 101, tmuxPane: '%3', tmuxWindow: 'api', parentSession: null, headless: false, ...overrides,
});

test('a new session starts as needs-me with an automatic note and writes no events', async () => {
  const store = await memoryStore();
  const session = store.startSession(start());
  assert.equal(session.status, 'needs-me');
  assert.equal(session.statusSource, 'auto');
  assert.equal(session.note, 'new session');
  assert.equal(session.statusAt, '2026-09-25T09:00:00.000Z');
  assert.equal(session.endedAt, null);
  assert.equal(session.parentSession, null);
  assert.equal(session.headless, false);
  assert.deepEqual(store.listEvents(), []);
});

test('restarting a session refreshes process fields but keeps its status and note', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.startSession(start());
  store.setSessionStatus('s1', 'waiting-external', 'CI run', 'agent');
  store.updateSession('s1', { endedAt: store.now() });
  now.advance(60_000);
  const again = store.startSession(start({ pid: 202, tmuxPane: null, tmuxWindow: null, parentSession: 'p1', headless: true }));
  assert.equal(again.pid, 202);
  assert.equal(again.tmuxPane, null);
  assert.equal(again.parentSession, 'p1');
  assert.equal(again.headless, true);
  assert.equal(again.endedAt, null);
  assert.equal(again.status, 'waiting-external');
  assert.equal(again.note, 'CI run');
  assert.equal(again.startedAt, '2026-09-25T09:01:00.000Z');
});

test('status_at changes only with the status, and notes are clipped to 200 characters', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.startSession(start());
  now.advance(1000);
  assert.equal(store.setSessionStatus('s1', 'working', '', 'auto').statusAt, '2026-09-25T09:00:01.000Z');
  now.advance(1000);
  const again = store.setSessionStatus('s1', 'working', 'still', 'auto');
  assert.equal(again.statusAt, '2026-09-25T09:00:01.000Z');
  assert.equal(again.note, 'still');
  const long = store.setSessionStatus('s1', 'needs-me', 'x'.repeat(300), 'agent');
  assert.equal(long.note.length, 200);
  assert.equal(long.statusSource, 'agent');
  assert.throws(() => store.setSessionStatus('nope', 'done', '', 'auto'), /Unknown session/);
  assert.deepEqual(store.listEvents(), []);
});

test('updateSession patches operational fields and deleteSession removes the row', async () => {
  const store = await memoryStore();
  store.startSession(start());
  store.startSession(start({ id: 's2' }));
  const updated = store.updateSession('s1', { lastTurnAt: '2026-09-25T10:00:00.000Z', tmuxWindow: 'renamed', name: 'Fix tests', restoredFrom: 101 });
  assert.equal(updated.lastTurnAt, '2026-09-25T10:00:00.000Z');
  assert.equal(updated.tmuxWindow, 'renamed');
  assert.equal(updated.name, 'Fix tests');
  assert.equal(updated.restoredFrom, 101);
  assert.deepEqual(store.listSessions().map((session) => session.id), ['s1', 's2']);
  assert.equal(store.deleteSession('s1'), true);
  assert.equal(store.deleteSession('s1'), false);
  assert.deepEqual(store.listSessions().map((session) => session.id), ['s2']);
  assert.throws(() => store.updateSession('nope', { name: 'x' }), /Unknown session/);
});

test('linkSession adds a session link, updates it with one event, and ignores repeats', async () => {
  const store = await memoryStore();
  const a = store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const b = store.addItem({ project: 'misc', title: 'B', origin: 'manual' }, 'user');
  store.startSession(start());
  const before = store.listEvents().length;
  const link = store.linkSession('s1', a.id, 'branch', 'session:s1');
  assert.equal(link.kind, 'session');
  assert.equal(link.key, 'session:s1');
  assert.deepEqual(link.state, { via: 'branch' });
  assert.equal(store.sessionLink('s1').itemId, 'W-1');
  assert.equal(store.listEvents().at(-1).actor, 'session:s1');
  store.linkSession('s1', a.id, 'branch', 'session:s1');
  assert.equal(store.listEvents().length, before + 1);
  const moved = store.linkSession('s1', b.id, 'manual', 'user');
  assert.equal(moved.itemId, 'W-2');
  assert.deepEqual(moved.state, { via: 'manual' });
  assert.equal(store.listEvents().at(-1).action, 'update');
  assert.equal(store.listEvents().length, before + 2);
  assert.throws(() => store.linkSession('s1', 'W-9', 'manual', 'user'), /Unknown item/);
});

test('a version 1 database migrates to version 2 with the new tables', () => {
  const path = join(tempDir(), 'work.db');
  const raw = new DatabaseSync(path);
  raw.exec(MIGRATIONS[0]);
  raw.exec('PRAGMA user_version = 1');
  raw.close();
  const store = WorkStore.open(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(store.listSessions(), []);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'job', 'usage') ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ['job', 'session', 'usage']);
  store.close();
});
