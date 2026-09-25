import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { exportJsonl, importJsonl, writeRotatingBackup } = await load('src/work/backup.ts');

async function populated() {
  const store = await memoryStore();
  store.upsertProject({ slug: 'payments', title: 'Payments' }, 'user');
  const item = store.addItem({ project: 'payments', title: 'A', origin: 'manual' }, 'user');
  store.addLink(item.id, { kind: 'jira', key: 'jira:ABC-1' }, 'user');
  store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k', title: 'T', reason: 'R' }, 'sync:github');
  store.addDismissal('d', 'user');
  store.savePlan({ date: '2026-09-25', itemIds: [item.id], quickActions: [], notes: '' }, 'planner');
  return store;
}

test('export and import round-trip every table', async () => {
  const source = await populated();
  const path = join(tempDir(), 'backup.jsonl');
  const rows = exportJsonl(source, path);
  assert.ok(rows > 5);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]), { format: 'work-backup', schema: 1 });
  const target = await memoryStore();
  importJsonl(target, path);
  assert.deepEqual(target.listItems(), source.listItems());
  assert.deepEqual(target.listAllLinks(), source.listAllLinks());
  assert.deepEqual(target.listCandidates(), source.listCandidates());
  assert.equal(target.isDismissed('d'), true);
  assert.deepEqual(target.getPlan('2026-09-25'), source.getPlan('2026-09-25'));
  assert.equal(target.addItem({ project: 'misc', title: 'next', origin: 'manual' }, 'user').id, 'W-2');
});

test('import refuses a non-empty database', async () => {
  const source = await populated();
  const path = join(tempDir(), 'backup.jsonl');
  exportJsonl(source, path);
  assert.throws(() => importJsonl(source, path), /non-empty/);
});

test('rotating backups keep the newest 14', async () => {
  const now = clock();
  const store = await memoryStore(now);
  const dir = join(tempDir(), 'backups');
  for (let i = 0; i < 16; i++) {
    writeRotatingBackup(store, dir, now());
    now.advance(60_000);
  }
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 14);
  assert.match(files[0], /^work-2026-09-25T09-02-00-000Z\.jsonl$/);
});
