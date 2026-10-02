import test from 'node:test';
import assert from 'node:assert/strict';
import { git, gitRepo, load, tempDir, writeFiles } from './helpers.mjs';

const { createChildGuard, failClosedGuard } = await load('src/work/children/child-guard.ts');
const { runGit } = await load('src/work/children/git.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

function makeRun(overrides = {}) {
  return {
    id: 'C-1', leadSession: 'lead-1', childSession: null, kind: 'implement',
    brief: { goal: 'Add retry', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null },
    model: 'anthropic/claude-sonnet-5', repo: 'api', worktree: null, branch: null, baseCommit: null, pid: null, outcome: 'running', flags: [], spendUsd: 0,
    diffLines: 0, diffFiles: 0, budgetLines: 300, budgetFiles: 8, acceptance: [], summary: '', createdAt: 't', endedAt: null, mergedAt: null, ...overrides,
  };
}

function guarded({ run = {}, config = DEFAULT_CHILDREN, cwd } = {}) {
  const dir = cwd ?? gitRepo({ 'src/a.ts': 'one\n' });
  const records = [];
  const aborts = [];
  const baseCommit = cwd ? null : git(dir, 'rev-parse', 'HEAD');
  const guard = createChildGuard({ run: makeRun({ worktree: dir, baseCommit, ...run }), config, cwd: dir, git: runGit, record: (patch) => records.push(patch), abort: () => aborts.push(true) });
  return { guard, dir, records, aborts };
}
const merged = (records) => Object.assign({}, ...records);
const usage = ({ total = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

test('edits are allowed only inside the worktree and the scope', () => {
  const { guard, dir } = guarded();
  assert.equal(guard.toolCall('edit', { path: 'src/a.ts' }), undefined);
  assert.equal(guard.toolCall('write', { path: `${dir}/src/new/b.ts` }), undefined);
  assert.match(guard.toolCall('write', { path: 'docs/x.md' }).reason, /^Blocked: docs\/x\.md is outside your scope \(src\/\*\*\)/);
  assert.match(guard.toolCall('edit', { path: '../other/src/a.ts' }).reason, /outside your worktree/);
  assert.match(guard.toolCall('write', { path: '.git/config' }).reason, /outside your worktree/);
  assert.equal(guard.toolCall('read', { path: '/etc/hosts' }), undefined);
});

test('shell commands are checked for restricted actions and full test runs, and get the timeout', () => {
  const config = { ...DEFAULT_CHILDREN, commandTimeoutMinutes: 2, repos: { api: { ignore: [], expensiveCommands: ['^make e2e$'] } } };
  const { guard } = guarded({ config });
  assert.match(guard.toolCall('bash', { command: 'git push origin HEAD' }).reason, /^Blocked: git push/);
  assert.match(guard.toolCall('bash', { command: 'npm test' }).reason, /repository-wide test run/);
  assert.match(guard.toolCall('bash', { command: 'make e2e' }).reason, /repository-wide test run/);
  const long = { command: 'node --test tests/a.test.mjs', timeout: 9999 };
  assert.equal(guard.toolCall('bash', long), undefined);
  assert.equal(long.timeout, 120);
  const short = { command: 'ls', timeout: 5 };
  guard.toolCall('bash', short);
  assert.equal(short.timeout, 5);
  const none = { command: 'ls' };
  guard.toolCall('bash', none);
  assert.equal(none.timeout, 120);
});

test('the diff budget warns at the threshold, allows reaching the limit, then blocks edits and limits the shell past it', () => {
  const { guard, dir, records } = guarded({ run: { budgetLines: 10, budgetFiles: 8 } });
  writeFiles(dir, { 'src/b.ts': '1\n2\n3\n4\n5\n6\n7\n' });
  assert.equal(guard.toolResult('write'), undefined);
  writeFiles(dir, { 'src/c.ts': '1\n' });
  assert.equal(guard.toolResult('write'), 'Budget 8/10 lines: finish the smallest working change.');
  writeFiles(dir, { 'src/d.ts': '1\n2\n' });
  assert.equal(guard.toolResult('bash'), 'Budget 10/10 lines: finish the smallest working change.');
  assert.deepEqual(guard.flags, []);
  assert.equal(guard.toolCall('edit', { path: 'src/a.ts' }), undefined);
  writeFiles(dir, { 'src/d.ts': '1\n2\n3\n' });
  assert.match(guard.toolResult('bash'), /^Budget exceeded \(11\/10 lines, 3\/8 files\)\. Edits are blocked\. Commit what you have/);
  assert.deepEqual(merged(records), { diffLines: 11, diffFiles: 3, flags: ['over-budget'] });
  assert.deepEqual(guard.flags, ['over-budget']);
  assert.match(guard.toolCall('edit', { path: 'src/a.ts' }).reason, /diff budget is exceeded/);
  assert.match(guard.toolCall('bash', { command: 'ls' }).reason, /Allowed now: git status/);
  for (const command of ['git status', 'git diff --stat', 'git add -A && git commit -m "wip; partial"', 'node --test tests/a.test.mjs']) {
    assert.equal(guard.toolCall('bash', { command }), undefined, command);
  }
  assert.ok(guard.toolCall('bash', { command: 'git status; rm -rf src' }));
});

test('the file count has its own warning and limit, and ignored paths do not count', () => {
  const config = { ...DEFAULT_CHILDREN, repos: { api: { ignore: ['src/fixtures/**'], expensiveCommands: [] } } };
  const { guard, dir, records } = guarded({ config, run: { budgetFiles: 5 } });
  writeFiles(dir, { 'package-lock.json': '{}\n'.repeat(50), 'src/fixtures/big.json': 'x\n'.repeat(50) });
  writeFiles(dir, { 'src/1.ts': 'a\n', 'src/2.ts': 'a\n', 'src/3.ts': 'a\n', 'src/4.ts': 'a\n' });
  assert.equal(guard.toolResult('edit'), 'Budget 4/5 files: finish the smallest working change.');
  assert.deepEqual(records.at(-1), { diffLines: 4, diffFiles: 4 });
  writeFiles(dir, { 'src/5.ts': 'a\n' });
  assert.equal(guard.toolResult('edit'), 'Budget 5/5 files: finish the smallest working change.');
  assert.deepEqual(guard.flags, []);
  writeFiles(dir, { 'src/6.ts': 'a\n' });
  assert.match(guard.toolResult('edit'), /^Budget exceeded \(6\/300 lines, 6\/5 files\)/);
});

test('computed spend warns once at the threshold, and at the cap aborts, blocks, and commits the work', () => {
  const { guard, dir, records, aborts } = guarded({ run: { model: DEFAULT_CHILDREN.defaultModel } });
  guard.assistantCost(usage({ input: 750_000 }));
  assert.equal(guard.toolResult('read'), undefined);
  guard.assistantCost(usage({ input: 375_000 }));
  assert.equal(guard.toolResult('read'), 'Spend $4.50 of $5.00: finish the smallest working change.');
  assert.equal(guard.toolResult('read'), undefined);
  writeFiles(dir, { 'src/b.ts': 'partial\n' });
  guard.assistantCost(usage({ input: 250_000 }));
  guard.assistantCost(usage({ input: 250_000 }));
  assert.equal(aborts.length, 1);
  assert.deepEqual(guard.flags, ['over-spend']);
  assert.deepEqual(records.filter((r) => 'spendUsd' in r).map((r) => r.spendUsd), [3, 4.5, 5.5, 6.5]);
  assert.match(guard.toolCall('bash', { command: 'ls' }).reason, /spending cap/);
  guard.agentEnd();
  guard.agentEnd();
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'WIP: C-1 stopped at the spend cap');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('an unpriced run marks spend unknown and never warns, aborts, or enforces the cap', () => {
  const { guard, records, aborts } = guarded({ run: { model: 'provider/unknown' } });
  guard.assistantCost(usage({ input: 10_000_000, output: 10_000_000 }));
  guard.assistantCost(usage({ total: 2 }));
  assert.deepEqual(guard.flags, ['unpriced']);
  assert.equal(records.some((record) => 'spendUsd' in record), false);
  assert.equal(guard.toolResult('read'), undefined);
  assert.deepEqual(aborts, []);
  assert.equal(guard.toolCall('bash', { command: 'ls' }), undefined);
});

test('a read-only run blocks edits and flags shell commands that change the lead directory', () => {
  const { guard, dir, records } = guarded({ run: { kind: 'read-only', budgetLines: null, budgetFiles: null, baseCommit: null } });
  const bash = (change = () => {}) => {
    assert.equal(guard.toolCall('bash', { command: 'ls' }), undefined);
    change();
    return guard.toolResult('bash');
  };
  assert.match(guard.toolCall('write', { path: 'src/a.ts' }).reason, /read-only run/);
  assert.equal(bash(), undefined);
  assert.match(bash(() => writeFiles(dir, { 'notes.txt': 'x\n' })), /changed files in the lead's working directory/);
  assert.equal(bash(() => writeFiles(dir, { 'more.txt': 'y\n' })), undefined);
  assert.deepEqual(merged(records), { flags: ['modified-files'] });
  assert.equal(git(dir, 'status', '--porcelain'), '?? more.txt\n?? notes.txt');
});

test("the lead's own edits and commits during a read-only run do not flag it", () => {
  const { guard, dir, records } = guarded({ run: { kind: 'read-only', budgetLines: null, budgetFiles: null, baseCommit: null } });
  const bash = (change = () => {}) => {
    guard.toolCall('bash', { command: 'git log --oneline' });
    change();
    return guard.toolResult('bash');
  };
  // Between the child's commands, the lead edits, then commits.
  writeFiles(dir, { 'src/a.ts': 'two\n', 'src/new.ts': 'new\n' });
  assert.equal(bash(), undefined);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'lead work');
  assert.equal(bash(), undefined);
  // While a child command runs, the lead commits work it already had: HEAD moves and dirty entries only disappear.
  writeFiles(dir, { 'src/a.ts': 'three\n' });
  assert.equal(bash(), undefined);
  assert.equal(bash(() => { git(dir, 'commit', '-qam', 'more lead work'); }), undefined);
  assert.deepEqual(records.filter((record) => 'flags' in record), []);
  // A command that does change files still flags.
  assert.match(bash(() => writeFiles(dir, { 'src/a.ts': 'child edit\n' })), /changed files/);
});

test('without git the budget cannot be measured, so edits are blocked', () => {
  const { guard, records } = guarded({ cwd: tempDir(), run: { baseCommit: 'abc123' } });
  assert.deepEqual(merged(records), { flags: ['no-git'] });
  assert.match(guard.toolCall('edit', { path: 'src/a.ts' }).reason, /git is unavailable/);
});

test('failClosedGuard blocks edits and the shell but allows reading', () => {
  const guard = failClosedGuard('Blocked: registry down.');
  assert.deepEqual(guard.toolCall('bash', { command: 'ls' }), { block: true, reason: 'Blocked: registry down.' });
  assert.deepEqual(guard.toolCall('edit', { path: 'a' }), { block: true, reason: 'Blocked: registry down.' });
  assert.equal(guard.toolCall('read', { path: 'a' }), undefined);
});
