import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const jiti = createJiti(import.meta.url);
const mod = await jiti.import('../../extensions/worktree-manager.ts');

test('parseWorktreeList returns selectable worktree entries with names from paths', () => {
  const porcelain = `worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.pi/worktrees/feature-auth\nHEAD def456\nbranch refs/heads/worktree-feature-auth\n\nworktree /repo/.pi/worktrees/fix-bug\nHEAD fedcba\ndetached\n`;

  assert.deepEqual(mod.parseWorktreeList(porcelain), [
    { path: '/repo', name: 'repo', branch: 'main' },
    { path: '/repo/.pi/worktrees/feature-auth', name: 'feature-auth', branch: 'worktree-feature-auth' },
    { path: '/repo/.pi/worktrees/fix-bug', name: 'fix-bug', branch: undefined },
  ]);
});

test('tmuxLaunchCommand creates a new window when already inside tmux', () => {
  assert.deepEqual(mod.tmuxLaunchCommand({ name: 'feature-auth', path: '/repo/.pi/worktrees/feature-auth', insideTmux: true }), {
    command: 'tmux',
    args: ['new-window', '-n', 'feature-auth', '-c', '/repo/.pi/worktrees/feature-auth', 'pi -c'],
    description: 'Started tmux window feature-auth',
  });
});

test('tmuxLaunchCommand creates a detached session when outside tmux', () => {
  assert.deepEqual(mod.tmuxLaunchCommand({ name: 'feature-auth', path: '/repo/.pi/worktrees/feature-auth', insideTmux: false }), {
    command: 'tmux',
    args: ['new-session', '-d', '-s', 'pi-feature-auth', '-c', '/repo/.pi/worktrees/feature-auth', 'pi -c'],
    description: 'Started tmux session pi-feature-auth. Attach with: tmux attach -t pi-feature-auth',
  });
});

test('identifyPiManagedWorktree accepts only .pi/worktrees paths on matching worktree branches', () => {
  assert.deepEqual(mod.identifyPiManagedWorktree('/repo/.pi/worktrees/feature-auth', 'worktree-feature-auth'), {
    name: 'feature-auth',
    path: '/repo/.pi/worktrees/feature-auth',
    branch: 'worktree-feature-auth',
  });

  assert.equal(mod.identifyPiManagedWorktree('/repo/.pi/worktrees/feature-auth', 'feature-auth'), undefined);
  assert.equal(mod.identifyPiManagedWorktree('/repo/other/feature-auth', 'worktree-feature-auth'), undefined);
  assert.equal(mod.identifyPiManagedWorktree('/repo/.pi/worktrees/feature-auth/nested', 'worktree-feature-auth'), undefined);
});

test('worktreeRemovalCommands uses safe remove first and force only after failure confirmation', () => {
  assert.deepEqual(mod.worktreeRemovalCommands('/repo/.pi/worktrees/feature-auth'), {
    safe: ['worktree', 'remove', '/repo/.pi/worktrees/feature-auth'],
    force: ['worktree', 'remove', '--force', '/repo/.pi/worktrees/feature-auth'],
  });
});

test('force removal prompt names the worktree path and the failed safe-removal output', () => {
  const prompt = mod.forceRemovalPrompt('/repo/.pi/worktrees/feature-auth', 'contains modified files');

  assert.match(prompt, /Force-remove this worktree\?/);
  assert.match(prompt, /\/repo\/\.pi\/worktrees\/feature-auth/);
  assert.match(prompt, /contains modified files/);
  assert.match(prompt, /git worktree remove --force/);
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeManagedWorktree() {
  const repo = mkdtempSync(join(tmpdir(), 'pi-cleanup-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'pi@example.com']);
  git(repo, ['config', 'user.name', 'Pi Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  const path = join(repo, '.pi', 'worktrees', 'cleanup');
  mkdirSync(join(repo, '.pi', 'worktrees'), { recursive: true });
  git(repo, ['worktree', 'add', '-b', 'worktree-cleanup', path, 'main']);
  return { repo, path, branch: 'worktree-cleanup' };
}

function shutdownHandler() {
  let handler;
  mod.default({
    on(name, candidate) {
      if (name === 'session_shutdown') handler = candidate;
    },
    registerCommand() {},
  });
  return handler;
}

async function runAutomaticCleanup(path) {
  const notifications = [];
  const previous = process.env.PI_WORKTREE_AUTO_CLEANUP;
  process.env.PI_WORKTREE_AUTO_CLEANUP = '1';
  try {
    await shutdownHandler()(
      { reason: 'quit' },
      {
        cwd: path,
        hasUI: false,
        ui: { notify(message, level) { notifications.push({ message, level }); } },
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_WORKTREE_AUTO_CLEANUP;
    else process.env.PI_WORKTREE_AUTO_CLEANUP = previous;
  }
  return notifications;
}

test('automatic cleanup preserves a dirty worktree and its branch', async () => {
  const managed = makeManagedWorktree();
  writeFileSync(join(managed.path, 'unsaved.txt'), 'do not delete\n');

  const notifications = await runAutomaticCleanup(managed.path);

  assert.equal(existsSync(managed.path), true);
  assert.match(git(managed.repo, ['branch', '--list', managed.branch]), /worktree-cleanup/);
  assert.match(notifications.at(-1).message, /dirty/i);
});

test('automatic cleanup safely removes a clean worktree but preserves its branch', async () => {
  const managed = makeManagedWorktree();

  await runAutomaticCleanup(managed.path);

  assert.equal(existsSync(managed.path), false);
  assert.match(git(managed.repo, ['branch', '--list', managed.branch]), /worktree-cleanup/);
});
