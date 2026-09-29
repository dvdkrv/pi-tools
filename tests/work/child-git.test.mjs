import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitRepo, load, tempDir, writeFiles } from './helpers.mjs';

const g = await load('src/work/children/git.ts');
const { BUILT_IN_IGNORE } = await load('src/work/children/guards.ts');

test('measureDiff counts tracked changes and untracked files, skipping ignored paths', () => {
  const dir = gitRepo({ 'src/a.ts': 'one\ntwo\n', 'package-lock.json': '{}\n' });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFiles(dir, { 'src/a.ts': 'one\nTWO\nthree\n', 'src/new.ts': 'x\ny\nz', 'package-lock.json': '{"a":1}\n', 'src/generated/g.ts': 'g\n' });
  assert.deepEqual(g.measureDiff(g.runGit, dir, { from: base, ignore: BUILT_IN_IGNORE }), { lines: 6, files: 2 });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'work');
  assert.deepEqual(g.measureDiff(g.runGit, dir, { from: base, to: 'HEAD', ignore: [] }), { lines: 9, files: 4 });
  assert.deepEqual(g.measureDiff(g.runGit, dir, { from: base, to: 'HEAD', ignore: ['src/new.ts'] }), { lines: 6, files: 3 });
});

test('parseNumstat reads binary files as zero lines', () => {
  assert.deepEqual(g.parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n'), [{ added: 3, deleted: 1, path: 'src/a.ts' }, { added: 0, deleted: 0, path: 'img.png' }]);
});

test('child worktrees are excluded locally, so the lead stays clean', () => {
  const dir = gitRepo();
  g.excludeChildWorktrees(g.runGit, dir);
  g.excludeChildWorktrees(g.runGit, dir);
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.pi/worktrees/').length, 1);
  const path = join(dir, '.pi', 'worktrees', 'child-C-1');
  g.addWorktree(g.runGit, dir, path, 'child/feat/C-1', 'HEAD');
  assert.equal(g.isClean(g.runGit, dir), true);
  writeFiles(path, { 'b.ts': 'b\n' });
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'child');
  assert.equal(g.commitsSince(g.runGit, dir, 'main', 'child/feat/C-1'), 1);
  g.removeWorktree(g.runGit, dir, path, 'child/feat/C-1');
  g.removeWorktree(g.runGit, dir, path, 'child/feat/C-1');
  assert.equal(existsSync(path), false);
  assert.equal(git(dir, 'branch', '--list', 'child/feat/C-1'), '');
  writeFiles(dir, { 'README.md': 'changed\n' });
  assert.equal(g.isClean(g.runGit, dir), false);
});

test('the default branch comes from origin/HEAD, with main and master as fallbacks', () => {
  const seed = gitRepo();
  const root = realpathSync(tempDir());
  git(root, 'clone', '-q', seed, 'clone');
  assert.equal(g.defaultBranchRef(g.runGit, join(root, 'clone')), 'origin/main');
  assert.equal(g.defaultBranchRef(g.runGit, seed), 'main');
  assert.equal(g.isDefaultBranch('main', undefined), true);
  assert.equal(g.isDefaultBranch('master', 'origin/main'), true);
  assert.equal(g.isDefaultBranch('trunk', 'origin/trunk'), true);
  assert.equal(g.isDefaultBranch('feat/x', 'origin/main'), false);
});

test('runGit reports git errors, and gitText turns failures into undefined', () => {
  const dir = tempDir();
  assert.throws(() => g.runGit(dir, ['rev-parse', 'HEAD']), /not a git repository/);
  assert.equal(g.gitText(g.runGit, dir, ['rev-parse', 'HEAD']), undefined);
  const repo = gitRepo();
  assert.equal(g.gitText(g.runGit, repo, ['branch', '--show-current']), 'main');
});

test('parseGithubRepo reads SSH and HTTPS remotes', () => {
  assert.equal(g.parseGithubRepo('git@github.com:example-org/api.git'), 'example-org/api');
  assert.equal(g.parseGithubRepo('https://github.com/example-org/api.git'), 'example-org/api');
  assert.equal(g.parseGithubRepo('https://github.com/example-org/api'), 'example-org/api');
  assert.equal(g.parseGithubRepo('/srv/git/api.git'), undefined);
});
