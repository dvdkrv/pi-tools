import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, memoryStore, tempDir } from './helpers.mjs';

const { tmuxRunner, listPanes, jumpToPane } = await load('src/work/tmux.ts');
const { runRestore } = await load('src/work/restore.ts');
const { shellQuote } = await load('src/work/planner.ts');

// Isolated server only: never the user's running tmux server.
const SOCKET = 'work-test';
const available = spawnSync('tmux', ['-V']).status === 0;
const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.sh', import.meta.url));
const dead = { kill: () => { throw new Error('kill ESRCH'); }, environ: () => undefined };

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

test('real tmux on an isolated server: restore into a shell pane, split, new window, and jump', { skip: available ? false : 'tmux is not installed' }, async () => {
  const tmux = tmuxRunner(SOCKET);
  try { tmux(['kill-server']); } catch { /* no stale isolated server */ }
  const dir = realpathSync(tempDir());
  const api = join(dir, 'api');
  const docs = join(dir, 'api', 'docs');
  const web = join(dir, 'web');
  for (const path of [api, docs, web]) mkdirSync(path, { recursive: true });
  try {
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'work', '-n', 'api', '-c', api, '-x', '160', '-y', '48', 'sh']);
    const store = await memoryStore();
    for (const [id, cwd, window] of [['a', api, 'api'], ['b', docs, 'api'], ['c', web, 'web']]) {
      const file = join(dir, `${id}.jsonl`);
      writeFileSync(file, '');
      store.startSession({ id, file, cwd, name: null, pid: 999_999, tmuxPane: `%9${id}`, tmuxWindow: window, parentSession: null, headless: false });
    }
    assert.equal(await waitFor(() => (listPanes(tmux) ?? []).some((pane) => pane.windowName === 'api' && pane.command === 'sh' && pane.path === api)), true, 'shell pane ready');

    const report = runRestore('manual', { store, tmux, readers: dead, bootId: () => 'test-boot', pi: `sh ${shellQuote(fakePi)}` });
    assert.equal(report.ran, true);
    assert.deepEqual(report.steps.map((step) => step.kind), ['send', 'split', 'window']);
    assert.deepEqual(report.failed, []);
    for (const id of ['a', 'b', 'c']) assert.equal(await waitFor(() => existsSync(join(dir, `${id}.jsonl.opened`))), true, `${id} opened`);

    const panes = listPanes(tmux);
    assert.equal(panes.filter((pane) => pane.windowName === 'api').length, 2);
    assert.equal(panes.filter((pane) => pane.windowName === 'web').length, 1);

    const target = report.placed.find((placed) => placed.sessionId === 'c').pane;
    assert.deepEqual(jumpToPane(tmux, target, true), { kind: 'jumped' });
    assert.equal(tmux(['display-message', '-p', '-t', 'work:', '#{pane_id}']).trim(), target);
  } finally {
    try { tmux(['kill-server']); } catch { /* already gone */ }
  }
});
