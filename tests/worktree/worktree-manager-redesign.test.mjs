import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const worktree = await jiti.import('../../extensions/worktree-manager.ts');
const ui = await jiti.import('../../src/worktree/fuzzy-select.ts');

test('picker custom actions use uppercase shortcuts without stealing lowercase search input', () => {
  assert.deepEqual(ui.pickerInputAction('N', [{ key: 'N', label: 'New' }]), { type: 'custom', key: 'N' });
  assert.equal(ui.pickerInputAction('n', [{ key: 'N', label: 'New' }]), undefined);
});

test('worktree manager registers only the interactive /worktree command and a shutdown cleanup hook', () => {
  const commands = [];
  const flags = [];
  const events = [];
  const fakePi = {
    registerCommand(name, options) {
      commands.push({ name, description: options.description });
    },
    registerFlag(name) {
      flags.push(name);
    },
    on(name, handler) {
      events.push({ name, handler });
    },
  };

  worktree.default(fakePi);

  assert.deepEqual(commands.map((command) => command.name), ['worktree']);
  assert.deepEqual(flags, []);
  assert.deepEqual(events.map((event) => event.name), ['session_shutdown']);
});

test('/worktree rejects non-TUI invocation before opening a picker', async () => {
  let handler;
  const notifications = [];
  worktree.default({
    on() {},
    registerCommand(_name, options) { handler = options.handler; },
  });

  await handler('', {
    mode: 'rpc',
    cwd: '/not/a/repository',
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  });

  assert.deepEqual(notifications, [{
    message: '/worktree is available only in interactive TUI mode',
    level: 'error',
  }]);
});

test('worktree cleanup only runs for quit shutdown events', () => {
  assert.equal(worktree.shouldCleanupManagedWorktree({ reason: 'quit' }), true);
  assert.equal(worktree.shouldCleanupManagedWorktree({ reason: 'new' }), false);
  assert.equal(worktree.shouldCleanupManagedWorktree({ reason: 'resume' }), false);
  assert.equal(worktree.shouldCleanupManagedWorktree({ reason: 'fork' }), false);
  assert.equal(worktree.shouldCleanupManagedWorktree({ reason: 'reload' }), false);
});

test('parseWorktreeManagerConfig accepts global repo search roots only', () => {
  assert.deepEqual(worktree.parseWorktreeManagerConfig('{"repoSearchRoots":["~/src","/opt/repos"]}'), {
    repoSearchRoots: ['~/src', '/opt/repos'],
    warnings: [],
  });

  assert.deepEqual(worktree.parseWorktreeManagerConfig('{"repoSearchRoots":"~/src"}'), {
    repoSearchRoots: [],
    warnings: ['repoSearchRoots must be an array of strings'],
  });
});

test('expandHome expands a leading tilde using the provided home directory', () => {
  assert.equal(worktree.expandHome('~/src', '/home/alice'), '/home/alice/src');
  assert.equal(worktree.expandHome('/opt/repos', '/home/alice'), '/opt/repos');
});

test('discoverRepositories scans immediate children and de-duplicates by repo root', () => {
  const children = new Map([
    ['/repos', ['agent', 'dotfiles', 'not-a-repo']],
  ]);
  const roots = new Map([
    ['/cwd', '/repos/dotfiles'],
    ['/repos/agent', '/repos/agent'],
    ['/repos/dotfiles', '/repos/dotfiles'],
  ]);

  const result = worktree.discoverRepositories({
    cwd: '/cwd',
    config: { repoSearchRoots: ['/repos'] },
    ops: {
      listDirectories(path) {
        return children.get(path)?.map((name) => `${path}/${name}`) ?? [];
      },
      gitRoot(path) {
        return roots.get(path);
      },
      realpath(path) {
        return path;
      },
    },
  });

  assert.deepEqual(result, {
    repos: [
      { alias: 'dotfiles', root: '/repos/dotfiles' },
      { alias: 'agent', root: '/repos/agent' },
    ],
    warnings: [],
  });
});

test('worktree picker entries are labelled as repo name followed by worktree name', () => {
  const entries = worktree.worktreePickerEntries(
    { alias: 'dotfiles', root: '/repos/dotfiles' },
    'worktree /repos/dotfiles\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repos/dotfiles/.pi/worktrees/feature-auth\nHEAD def456\nbranch refs/heads/worktree-feature-auth\n',
  );

  assert.deepEqual(entries.map((entry) => ({ label: entry.label, searchText: entry.searchText })), [
    {
      label: 'dotfiles / dotfiles',
      searchText: 'dotfiles\ndotfiles\nmain\n/repos/dotfiles',
    },
    {
      label: 'dotfiles / feature-auth',
      searchText: 'dotfiles\nfeature-auth\nworktree-feature-auth\n/repos/dotfiles/.pi/worktrees/feature-auth',
    },
  ]);
});

test('identifyPiManagedWorktreeForRepo requires matching repo .pi path and branch', () => {
  assert.deepEqual(
    worktree.identifyPiManagedWorktreeForRepo('/repos/dotfiles', '/repos/dotfiles/.pi/worktrees/feature-auth', 'worktree-feature-auth'),
    { name: 'feature-auth', path: '/repos/dotfiles/.pi/worktrees/feature-auth', branch: 'worktree-feature-auth' },
  );

  assert.equal(
    worktree.identifyPiManagedWorktreeForRepo('/repos/dotfiles', '/repos/other/.pi/worktrees/feature-auth', 'worktree-feature-auth'),
    undefined,
  );
  assert.equal(
    worktree.identifyPiManagedWorktreeForRepo('/repos/dotfiles', '/repos/dotfiles/.pi/worktrees/feature-auth', 'feature-auth'),
    undefined,
  );
});
