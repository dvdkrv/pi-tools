import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIo, clock, load, memoryRuntime, memoryStore, tempDir } from './helpers.mjs';

const restore = await load('src/work/restore.ts');
const { runCli } = await load('src/work/cli.ts');

const NOW = new Date('2026-09-25T09:00:00.000Z');
const session = (overrides = {}) => {
  const id = overrides.id ?? 's1';
  return {
    id, file: `/s/${id}.jsonl`, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api',
    startedAt: '2026-09-24T09:00:00.000Z', lastTurnAt: null, endedAt: null, status: 'working', note: '', statusSource: 'auto',
    statusAt: '2026-09-24T09:00:00.000Z', restoredFrom: null, parentSession: null, headless: false, liveness: 'crashed', alive: false,
    ...overrides,
  };
};
const pane = (paneId, windowId, windowName, path, command = 'zsh') => ({ paneId, windowId, windowName, sessionName: 'main', path, command });
const dead = { kill: () => { throw new Error('kill ESRCH'); }, environ: () => undefined };

function tmuxFake(calls = [], panes = '%2\t@1\tshell\tmain\t/home\tzsh') {
  return (args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return panes;
    if (args[0] === 'new-window') return '@9\t%20\n';
    if (args[0] === 'split-window') return '%21\n';
    return '';
  };
}

async function restoreStore(now = clock()) {
  const store = await memoryStore(now);
  store.startSession({ id: 's1', file: '/s/s1.jsonl', cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  return store;
}

test('placement reuses a matching shell pane, then splits the window, then creates a window and reuses it', () => {
  const steps = restore.planRestore([
    session({ id: 'a' }),
    session({ id: 'b', cwd: '/src/api/docs' }),
    session({ id: 'c', tmuxWindow: 'web', cwd: '/src/web' }),
    session({ id: 'd', tmuxWindow: 'web', cwd: '/src/web' }),
  ], [pane('%5', '@2', 'api', '/src/api'), pane('%6', '@3', 'notes', '/src/api', 'vim')]);
  assert.deepEqual(steps, [
    { kind: 'send', sessionId: 'a', pane: '%5', command: "pi --session '/s/a.jsonl'" },
    { kind: 'split', sessionId: 'b', window: '@2', cwd: '/src/api/docs', command: "pi --session '/s/b.jsonl'" },
    { kind: 'window', sessionId: 'c', name: 'web', cwd: '/src/web', command: "pi --session '/s/c.jsonl'" },
    { kind: 'split', sessionId: 'd', window: 'new:web', cwd: '/src/web', command: "pi --session '/s/d.jsonl'" },
  ]);
});

test('sessions that shared a window return as panes of it, and busy panes are not reused', () => {
  const steps = restore.planRestore([session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })], [
    pane('%5', '@2', 'api', '/src/api'),
    pane('%6', '@2', 'api', '/src/api', 'node'),
    pane('%7', '@2', 'api', '/src/api', 'bash'),
  ]);
  assert.deepEqual(steps.map((step) => [step.kind, step.pane ?? step.window]), [['send', '%5'], ['send', '%7'], ['split', '@2']]);
});

test('a session without a window name uses its directory name, and a custom pi command is used as given', () => {
  const [step] = restore.planRestore([session({ tmuxWindow: null })], [], "sh '/x/fake-pi.sh'");
  assert.deepEqual(step, { kind: 'window', sessionId: 's1', name: 'api', cwd: '/src/api', command: "sh '/x/fake-pi.sh' --session '/s/s1.jsonl'" });
});

test('selection takes crashed, unfinished, top-level sessions from the last 7 days and reports missing files', () => {
  const exists = (path) => path !== '/s/gone.jsonl';
  const { selected, skipped } = restore.selectForRestore([
    session({ id: 'ok' }),
    session({ id: 'old', startedAt: '2026-09-17T08:00:00.000Z' }),
    session({ id: 'recent-turn', startedAt: '2026-09-10T08:00:00.000Z', lastTurnAt: '2026-09-24T08:00:00.000Z' }),
    session({ id: 'done', status: 'done' }),
    session({ id: 'closed', liveness: 'closed', endedAt: '2026-09-24T10:00:00.000Z' }),
    session({ id: 'live', liveness: 'live', alive: true }),
    session({ id: 'orphan', alive: true }),
    session({ id: 'headless', headless: true, tmuxPane: null, tmuxWindow: null }),
    session({ id: 'outside-tmux', tmuxPane: null, tmuxWindow: null }),
    session({ id: 'child', headless: true, tmuxPane: null, parentSession: 'ok' }),
    session({ id: 'no-file', file: null }),
    session({ id: 'gone' }),
  ].map((s) => (s.id === 'gone' ? { ...s, file: '/s/gone.jsonl' } : s)), NOW, exists);
  assert.deepEqual(selected.map((s) => s.id), ['recent-turn', 'ok']);
  assert.deepEqual(skipped, [{ sessionId: 'no-file', reason: 'session file missing' }, { sessionId: 'gone', reason: 'session file missing' }]);
});

test('executeRestore types into shells, splits, reuses windows it created, and reports failures', () => {
  const calls = [];
  const tmux = (args) => {
    calls.push(args);
    if (args[0] === 'new-window') return '@9\t%20\n';
    if (args[0] === 'split-window' && args.includes('/broken')) throw new Error('create pane failed: pane too small');
    if (args[0] === 'split-window') return '%21\n';
    return '';
  };
  const result = restore.executeRestore([
    { kind: 'send', sessionId: 'a', pane: '%5', command: 'pi --session a' },
    { kind: 'window', sessionId: 'c', name: 'web', cwd: '/src/web', command: 'pi --session c' },
    { kind: 'split', sessionId: 'd', window: 'new:web', cwd: '/src/web', command: 'pi --session d' },
    { kind: 'split', sessionId: 'e', window: '@9', cwd: '/broken', command: 'pi --session e' },
  ], tmux);
  assert.deepEqual(result.placed, [{ sessionId: 'a', pane: '%5' }, { sessionId: 'c', pane: '%20' }, { sessionId: 'd', pane: '%21' }]);
  assert.deepEqual(result.failed, [{ sessionId: 'e', error: 'create pane failed: pane too small' }]);
  assert.deepEqual(calls.slice(0, 4), [
    ['send-keys', '-t', '%5', '-l', 'pi --session a'],
    ['send-keys', '-t', '%5', 'Enter'],
    ['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-n', 'web', '-c', '/src/web', 'pi --session c'],
    ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', '@9', '-c', '/src/web', 'pi --session d'],
  ]);
});

test('auto restore runs once per boot, manual restore ignores the marker, and dry runs change nothing', async () => {
  const store = await restoreStore();
  const calls = [];
  const deps = { store, tmux: tmuxFake(calls), readers: dead, bootId: () => 'boot-1', fileExists: () => true };
  const dry = restore.runRestore('dry-run', deps);
  assert.equal(dry.ran, false);
  assert.equal(dry.steps.length, 1);
  assert.equal(store.getMeta('restore:boot:boot-1'), undefined);
  assert.deepEqual(calls.filter((call) => call[0] !== 'list-panes'), []);
  const first = restore.runRestore('auto', deps);
  assert.equal(first.ran, true);
  assert.deepEqual(first.placed, [{ sessionId: 's1', pane: '%20' }]);
  assert.equal(store.getSession('s1').restoredFrom, 11);
  assert.ok(store.getMeta('restore:boot:boot-1'));
  const second = restore.runRestore('auto', deps);
  assert.equal(second.ran, false);
  assert.match(second.reason, /already restored/);
  assert.equal(restore.runRestore('manual', deps).ran, true);
  assert.equal(restore.runRestore('auto', { ...deps, bootId: () => 'boot-2' }).ran, true);
});

test('without a boot ID, auto restore waits 10 minutes between runs', async () => {
  const now = clock();
  const store = await restoreStore(now);
  const deps = { store, tmux: tmuxFake(), readers: dead, bootId: () => undefined, fileExists: () => true };
  assert.equal(restore.runRestore('auto', deps).ran, true);
  now.advance(9 * 60_000);
  assert.equal(restore.runRestore('auto', deps).ran, false);
  now.advance(2 * 60_000);
  assert.equal(restore.runRestore('auto', deps).ran, true);
});

test('restore does nothing and claims nothing when tmux is not running', async () => {
  const store = await restoreStore();
  const report = restore.runRestore('auto', { store, tmux: () => { throw new Error('no server running'); }, readers: dead, bootId: () => 'b', fileExists: () => true });
  assert.equal(report.ran, false);
  assert.match(report.reason, /tmux is not running/);
  assert.equal(store.getMeta('restore:boot:b'), undefined);
});

test('reopenSession places one session and refuses running or missing sessions', async () => {
  const store = await restoreStore();
  assert.equal(restore.reopenSession(store, session({ liveness: 'closed', endedAt: 'x' }), tmuxFake(), [], { fileExists: () => true }), '%20');
  assert.equal(store.getSession('s1').restoredFrom, 11);
  assert.throws(() => restore.reopenSession(store, session({ alive: true }), tmuxFake(), [], { fileExists: () => true }), /still running/);
  assert.throws(() => restore.reopenSession(store, session(), tmuxFake(), [], { fileExists: () => false }), /file is missing/);
});

test('formatRestoreReport describes plans, results, skips, and failures', () => {
  const step = { kind: 'window', sessionId: 's1', name: 'api', cwd: '/src/api', command: 'pi --session x' };
  assert.equal(restore.formatRestoreReport({ mode: 'dry-run', ran: false, steps: [step], placed: [], failed: [], skipped: [] }), 'Would restore 1 session:\n  s1: new window api in /src/api: pi --session x');
  assert.equal(restore.formatRestoreReport({ mode: 'auto', ran: false, reason: 'already restored since this boot', steps: [], placed: [], failed: [], skipped: [] }), 'Restore skipped: already restored since this boot');
  assert.equal(
    restore.formatRestoreReport({ mode: 'manual', ran: true, steps: [step], placed: [{ sessionId: 's1', pane: '%20' }], failed: [{ sessionId: 's2', error: 'boom' }], skipped: [{ sessionId: 's3', reason: 'session file missing' }] }),
    'Restored 1 session\n  s1 in pane %20\nSkipped s3: session file missing\nFailed s2: boom',
  );
  assert.equal(restore.formatRestoreReport({ mode: 'manual', ran: true, steps: [], placed: [], failed: [], skipped: [] }), 'Nothing to restore');
});

test('work restore --dry-run prints the plan', async () => {
  const dir = tempDir();
  const file = join(dir, 's1.jsonl');
  writeFileSync(file, '');
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 's1', file, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  const io = captureIo();
  const code = await runCli(['restore', '--dry-run'], { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, tmux: tmuxFake(), readers: dead, bootId: () => 'b' });
  assert.equal(code, 0);
  assert.equal(io.out.join('\n'), `Would restore 1 session:\n  s1: new window api in /src/api: pi --session '${file}'`);
});
