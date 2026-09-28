import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { exportJsonl, importJsonl } = await load('src/work/backup.ts');

const job = (overrides = {}) => ({ name: 'nightly-export', kind: 'cron', cwd: '/srv/export', ...overrides });

test('registering creates a job with one event, and the same name updates it in place', async () => {
  const now = clock();
  const store = await memoryStore(now);
  const item = store.addItem({ project: 'misc', title: 'Exports', origin: 'manual' }, 'user');
  const first = store.registerJob(job({ schedule: '0 3 * * *', checkCommand: 'test -f out.csv', ownerSession: 's1', itemId: item.id }), 'agent:s1');
  assert.equal(first.created, true);
  assert.equal(first.job.id, 'J-1');
  assert.deepEqual([first.job.schedule, first.job.checkCommand, first.job.ownerSession, first.job.itemId, first.job.stopCommand], ['0 3 * * *', 'test -f out.csv', 's1', 'W-1', null]);
  assert.deepEqual([store.listEvents().at(-1).entity, store.listEvents().at(-1).action, store.listEvents().at(-1).actor], ['job:J-1', 'create', 'agent:s1']);
  now.advance(1000);
  const events = store.listEvents().length;
  const again = store.registerJob(job({ stopCommand: 'crontab -l | grep -v export | crontab -' }), 'agent:s1');
  assert.equal(again.created, false);
  assert.equal(again.job.id, 'J-1');
  assert.equal(again.job.checkCommand, 'test -f out.csv');
  assert.equal(again.job.itemId, 'W-1');
  assert.equal(again.job.stopCommand, 'crontab -l | grep -v export | crontab -');
  assert.equal(store.listEvents().at(-1).action, 'update');
  assert.equal(store.listEvents().length, events + 1);
  store.registerJob(job(), 'agent:s1');
  assert.equal(store.listEvents().length, events + 1);
  assert.equal(store.registerJob(job({ checkCommand: null }), 'user').job.checkCommand, null);
});

test('a stopped job frees its name, and only stopped jobs can be deleted', async () => {
  const store = await memoryStore();
  store.registerJob(job(), 'user');
  assert.throws(() => store.deleteJob('J-1', 'user'), /Only stopped jobs/);
  const stopped = store.markJobStopped('J-1', 'user');
  assert.ok(stopped.stoppedAt);
  assert.equal(store.listEvents().at(-1).action, 'stop');
  assert.throws(() => store.markJobStopped('J-1', 'user'), /already stopped/);
  assert.equal(store.registerJob(job(), 'user').job.id, 'J-2');
  assert.deepEqual(store.listJobs().map((j) => j.id), ['J-2', 'J-1']);
  assert.deepEqual(store.listJobs({ activeOnly: true }).map((j) => j.id), ['J-2']);
  store.deleteJob('J-1', 'user');
  assert.equal(store.getJob('J-1'), undefined);
  assert.equal(store.listEvents().at(-1).action, 'delete');
});

test('registration is validated', async () => {
  const store = await memoryStore();
  assert.throws(() => store.registerJob(job({ kind: 'daemon' }), 'user'), /kind must be one of cron, process/);
  assert.throws(() => store.registerJob(job({ name: '  ' }), 'user'), /name must not be empty/);
  assert.throws(() => store.registerJob(job({ name: 'x'.repeat(81) }), 'user'), /at most 80/);
  assert.throws(() => store.registerJob(job({ pid: 0 }), 'user'), /positive integer/);
  assert.throws(() => store.registerJob(job({ pid: Number.NaN }), 'user'), /positive integer/);
  assert.throws(() => store.registerJob(job({ itemId: 'W-9' }), 'user'), /Unknown item/);
  assert.throws(() => store.getJob('W-1'), /Invalid job ID/);
});

test('check results are operational and clipped to 200 characters', async () => {
  const store = await memoryStore();
  store.registerJob(job(), 'user');
  const events = store.listEvents().length;
  const checked = store.recordJobCheck('J-1', 'unhealthy', 'e'.repeat(300));
  assert.equal(checked.lastCheckStatus, 'unhealthy');
  assert.equal(checked.lastCheckOutput.length, 200);
  assert.equal(checked.lastCheckAt, '2026-09-25T09:00:00.000Z');
  assert.equal(store.listEvents().length, events);
  assert.throws(() => store.recordJobCheck('J-9', 'healthy', ''), /Unknown job/);
});

test('jobs are included in backups', async () => {
  const source = await memoryStore();
  source.registerJob(job({ checkCommand: 'true' }), 'user');
  const path = join(tempDir(), 'backup.jsonl');
  exportJsonl(source, path);
  const target = await memoryStore();
  importJsonl(target, path);
  assert.deepEqual(target.listJobs(), source.listJobs());
});
