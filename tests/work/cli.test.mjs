import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { captureIo, load, memoryRuntime, tempDir } from './helpers.mjs';

const run = promisify(execFile);
const { runCli, parseAssignments } = await load('src/work/cli.ts');

async function cli(argv, { runtime, answers } = {}) {
  const rt = runtime ?? await memoryRuntime();
  const io = captureIo(answers);
  const code = await runCli(argv, { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, repoFromCwd: () => undefined });
  return { code, rt, ...io };
}

test('add captures an item and prints its ID', async () => {
  const { code, out, rt } = await cli(['add', 'write', 'the', 'plan', 'due:2026-10-01']);
  assert.equal(code, 0);
  assert.deepEqual(out, ['W-1 added to misc']);
  assert.equal(rt.store.getItem('W-1').due, '2026-10-01');
});

test('list groups open items by project and hides done items unless --all', async () => {
  const rt = await memoryRuntime({ config: { github: { accounts: [] }, projects: [{ slug: 'payments', title: 'Payments' }], rules: [] } });
  rt.store.addItem({ project: 'payments', title: 'Fix flake', origin: 'manual' }, 'user');
  const done = rt.store.addItem({ project: 'misc', title: 'Old', origin: 'manual' }, 'user');
  rt.store.updateItem(done.id, { status: 'done' }, 'user');
  const open = await cli(['list'], { runtime: rt });
  assert.match(open.out.join('\n'), /payments \(Payments\)\n {2}W-1 +todo +Fix flake/);
  assert.doesNotMatch(open.out.join('\n'), /Old/);
  const all = await cli(['list', '--all'], { runtime: rt });
  assert.match(all.out.join('\n'), /W-2 +done +Old/);
});

test('set parses key=value pairs, including multi-word values', async () => {
  const { rt } = await cli(['add', 'review PR']);
  const r = await cli(['set', 'W-1', 'status=waiting', 'waiting_on=review', 'reason=round', 'two', 'pinned=yes'], { runtime: rt });
  assert.equal(r.code, 0);
  const item = rt.store.getItem('W-1');
  assert.equal(item.status, 'waiting');
  assert.equal(item.waitingReason, 'round two');
  assert.equal(item.pinned, true);
  assert.deepEqual(parseAssignments(['a=1', 'b=x', 'y']), { a: '1', b: 'x y' });
});

test('errors are printed and return exit code 1', async () => {
  const r = await cli(['set', 'W-9', 'status=done']);
  assert.equal(r.code, 1);
  assert.match(r.err[0], /Unknown item: W-9/);
  const u = await cli(['nope']);
  assert.equal(u.code, 1);
  assert.match(u.err[0], /Unknown command/);
});

test('show prints links and history', async () => {
  const { rt } = await cli(['add', 'x', 'https://example.atlassian.net/browse/ABC-1']);
  const r = await cli(['show', 'W-1'], { runtime: rt });
  const text = r.out.join('\n');
  assert.match(text, /W-1 +todo +x/);
  assert.match(text, /jira +jira:ABC-1/);
  assert.match(text, /user +create/);
});

test('project lists, adds, and updates projects', async () => {
  const { rt } = await cli(['project', 'add', 'payments', 'Payments', 'team']);
  assert.equal(rt.store.getProject('payments').title, 'Payments team');
  await cli(['project', 'set', 'payments', 'status=parked', 'epic=ABC-100'], { runtime: rt });
  assert.equal(rt.store.getProject('payments').status, 'parked');
  assert.equal(rt.store.getProject('payments').jiraEpic, 'ABC-100');
  const listed = await cli(['project'], { runtime: rt });
  assert.match(listed.out[0], /payments +parked +Payments team +epic ABC-100/);
  const dup = await cli(['project', 'add', 'payments', 'Again'], { runtime: rt });
  assert.equal(dup.code, 1);
});

test('bin/work.ts runs under Node type stripping with XDG paths', async () => {
  const dir = tempDir();
  const env = { ...process.env, XDG_DATA_HOME: join(dir, 'data'), XDG_CONFIG_HOME: join(dir, 'config') };
  const bin = new URL('../../bin/work.ts', import.meta.url).pathname;
  const { stdout } = await run(process.execPath, [bin, 'add', 'smoke', 'test'], { env, cwd: dir });
  assert.equal(stdout.trim(), 'W-1 added to misc');
});
