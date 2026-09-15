import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const core = await jiti.import('../../src/worktree/index.ts');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(path, content) {
  writeFileSync(path, content, 'utf8');
}

function makeRepoWithRemote() {
  const root = mkdtempSync(join(tmpdir(), 'pi-worktree-core-remote-'));
  const seed = join(root, 'seed');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const upstream = join(root, 'upstream');

  mkdirSync(seed);
  git(seed, ['init', '-b', 'main']);
  git(seed, ['config', 'user.email', 'pi@example.com']);
  git(seed, ['config', 'user.name', 'Pi Test']);
  git(seed, ['config', 'commit.gpgsign', 'false']);
  write(join(seed, 'file.txt'), 'initial\n');
  git(seed, ['add', 'file.txt']);
  git(seed, ['commit', '-m', 'initial']);
  git(seed, ['clone', '--bare', '.', origin]);

  git(root, ['clone', origin, repo]);
  git(repo, ['checkout', '-b', 'feature']);

  git(root, ['clone', origin, upstream]);
  git(upstream, ['config', 'user.email', 'pi@example.com']);
  git(upstream, ['config', 'user.name', 'Pi Test']);
  git(upstream, ['config', 'commit.gpgsign', 'false']);
  write(join(upstream, 'file.txt'), 'initial\nlatest\n');
  git(upstream, ['commit', '-am', 'latest default branch commit']);
  git(upstream, ['push', 'origin', 'main']);
  const latestDefaultHead = git(upstream, ['rev-parse', 'HEAD']);

  return { repo, latestDefaultHead };
}

test('slugify creates stable worktree-safe names', () => {
  assert.equal(core.slugify('Fix Flaky E2E Framework'), 'fix-flaky-e2e-framework');
  assert.equal(core.slugify(''), 'worktree');
});

test('ensureWorktreePlan derives Pi-managed path and branch', () => {
  assert.deepEqual(core.ensureWorktreePlan('/repos/agent', 'Fix Flaky E2E Framework'), {
    repoRoot: '/repos/agent',
    name: 'fix-flaky-e2e-framework',
    branch: 'worktree-fix-flaky-e2e-framework',
    path: '/repos/agent/.pi/worktrees/fix-flaky-e2e-framework',
  });
});

test('resolveWorktreeBaseRef uses the current branch by default', () => {
  const { repo } = makeRepoWithRemote();

  assert.equal(core.resolveWorktreeBaseRef(repo), 'feature');
});

test('resolveWorktreeBaseRef fetches and uses the latest remote default branch when requested', () => {
  const { repo, latestDefaultHead } = makeRepoWithRemote();

  const baseRef = core.resolveWorktreeBaseRef(repo, { defaultBase: 'remoteDefault' });

  assert.equal(baseRef, 'origin/main');
  assert.equal(git(repo, ['rev-parse', baseRef]), latestDefaultHead);
});

test('resolveWorktreeBaseRef honors an explicit base ref without resolving the remote default branch', () => {
  const { repo } = makeRepoWithRemote();

  assert.equal(core.resolveWorktreeBaseRef(repo, { baseRef: 'feature' }), 'feature');
});

test('ensureWorktree can create from the latest remote default branch', () => {
  const { repo, latestDefaultHead } = makeRepoWithRemote();

  const worktree = core.ensureWorktree(repo, 'default-base-task', { defaultBase: 'remoteDefault' });

  assert.equal(worktree.created, true);
  assert.equal(git(worktree.path, ['rev-parse', 'HEAD']), latestDefaultHead);
});

test('tmuxPiLaunchCommand launches a fresh Pi session with shell-quoted prompt', () => {
  assert.deepEqual(core.tmuxPiLaunchCommand({
    name: 'fix-flaky',
    path: '/repos/agent/.pi/worktrees/fix-flaky',
    prompt: "Fix Bob's flaky test",
    insideTmux: false,
  }), {
    command: 'tmux',
    args: ['new-session', '-d', '-s', 'pi-fix-flaky', '-c', '/repos/agent/.pi/worktrees/fix-flaky', "pi 'Fix Bob'\\''s flaky test'"],
    description: 'Started tmux session pi-fix-flaky. Attach with: tmux attach -t pi-fix-flaky',
  });
});

test('tmuxPiLaunchCommand marks task sessions for auto cleanup when requested', () => {
  assert.deepEqual(core.tmuxPiLaunchCommand({
    name: 'fix-flaky',
    path: '/repos/agent/.pi/worktrees/fix-flaky',
    prompt: 'Fix flaky test',
    insideTmux: true,
    autoCleanup: true,
  }).args.at(-1), "PI_WORKTREE_AUTO_CLEANUP=1 pi 'Fix flaky test'");
});

test('tmuxPiLaunchCommand creates split panes inside tmux when requested', () => {
  assert.deepEqual(core.tmuxPiLaunchCommand({
    name: 'fix-flaky',
    path: '/repos/agent/.pi/worktrees/fix-flaky',
    prompt: 'Fix flaky test',
    insideTmux: true,
    split: true,
  }), {
    command: 'tmux',
    args: ['split-window', '-c', '/repos/agent/.pi/worktrees/fix-flaky', "pi 'Fix flaky test'"],
    description: 'Started tmux split pane fix-flaky',
  });
});

test('tmuxPiLaunchCommand falls back to detached sessions for split outside tmux', () => {
  assert.deepEqual(core.tmuxPiLaunchCommand({
    name: 'fix-flaky',
    path: '/repos/agent/.pi/worktrees/fix-flaky',
    prompt: 'Fix flaky test',
    insideTmux: false,
    split: true,
  }).args.slice(0, 4), ['new-session', '-d', '-s', 'pi-fix-flaky']);
});

test('runGit does not leak stderr when callers catch failures', () => {
  const nonRepo = mkdtempSync(join(tmpdir(), 'pi-worktree-core-nonrepo-'));
  const script = `
    const { createJiti } = require('jiti');
    const jiti = createJiti(process.cwd() + '/test.js');
    (async () => {
      const core = await jiti.import('./src/worktree/index.ts');
      try { core.runGit(${JSON.stringify(nonRepo)}, ['rev-parse', '--show-toplevel']); } catch {}
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.stderr, '');
});

test('parseWorktreeManagerConfig accepts repoSearchRoots arrays', () => {
  assert.deepEqual(core.parseWorktreeManagerConfig('{"repoSearchRoots":["~/src"]}'), {
    repoSearchRoots: ['~/src'],
    warnings: [],
  });
});

test('isCleanWorktreeStatus only accepts empty porcelain output', () => {
  assert.equal(core.isCleanWorktreeStatus(''), true);
  assert.equal(core.isCleanWorktreeStatus('  \n'), true);
  assert.equal(core.isCleanWorktreeStatus('?? untracked.txt\n'), false);
  assert.equal(core.isCleanWorktreeStatus(' M changed.txt\n'), false);
});

test('discoverRepositories excludes ambiguous basename aliases and reports their roots', () => {
  const result = core.discoverRepositories({
    cwd: '/outside',
    config: { repoSearchRoots: ['/first', '/second'] },
    ops: {
      listDirectories(path) {
        return path === '/first' ? ['/first/api'] : ['/second/api'];
      },
      gitRoot(path) {
        return path === '/outside' ? undefined : path;
      },
      realpath(path) {
        return path;
      },
    },
  });

  assert.deepEqual(result.repos, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Ambiguous repo alias api/);
  assert.match(result.warnings[0], /\/first\/api/);
  assert.match(result.warnings[0], /\/second\/api/);
});

test('ensureWorktree rejects an existing path that is not a registered worktree', () => {
  const { repo } = makeRepoWithRemote();
  const plan = core.ensureWorktreePlan(repo, 'occupied');
  mkdirSync(plan.path, { recursive: true });

  assert.throws(
    () => core.ensureWorktree(repo, 'occupied', { baseRef: 'main' }),
    /exists but is not the expected git worktree/,
  );
});

test('ensureWorktree reuses an existing worktree without fetching its base again', () => {
  const { repo } = makeRepoWithRemote();
  core.ensureWorktree(repo, 'offline-reuse', { baseRef: 'main' });
  git(repo, ['remote', 'remove', 'origin']);

  const reused = core.ensureWorktree(repo, 'offline-reuse', { defaultBase: 'remoteDefault' });

  assert.equal(reused.created, false);
  assert.equal(reused.branch, 'worktree-offline-reuse');
});

test('ensureWorktree reuses only a registered worktree on the expected branch', () => {
  const { repo } = makeRepoWithRemote();
  const created = core.ensureWorktree(repo, 'reusable', { baseRef: 'main' });

  const reused = core.ensureWorktree(repo, 'reusable', { baseRef: 'main' });

  assert.equal(created.created, true);
  assert.equal(reused.created, false);
  assert.equal(reused.path, created.path);
  assert.equal(reused.branch, 'worktree-reusable');
});
