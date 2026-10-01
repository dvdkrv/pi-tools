import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configureGit, git, gitRepo, load, memoryStore, tempDir, writeFiles } from './helpers.mjs';

const { mergeChild } = await load('src/work/children/merge.ts');
const { addWorktree, excludeChildWorktrees, runGit } = await load('src/work/children/git.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

const REMOTE = 'https://github.com/example-org/api.git';
const PR = 'https://github.com/example-org/api/pull/7';
const BRIEF = { goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['true'], context: '', model: null, modelReason: null, from: null };
const REPO_LEAD = '0195d5e8-7abc-7000-8000-1234deadbeef';

// A lead clone on feat/x whose origin URL names GitHub but pushes to a local bare repository, plus a fake gh.
async function project({ accounts = [{ user: 'work-account', orgs: ['example-org'] }] } = {}) {
  const seed = gitRepo({ 'src/a.ts': 'one\n' });
  const root = realpathSync(tempDir());
  const bare = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', seed, bare);
  git(root, 'clone', '-q', bare, 'lead');
  const lead = join(root, 'lead');
  configureGit(lead);
  git(lead, 'config', 'remote.origin.url', REMOTE);
  git(lead, 'config', `url.${bare}.insteadOf`, REMOTE);
  git(lead, 'checkout', '-q', '-b', 'feat/x');
  excludeChildWorktrees(runGit, lead);
  const prs = [];
  const calls = [];
  const gh = async (args, env) => {
    calls.push({ args, env });
    if (args[0] === 'auth') return 'tok-123\n';
    if (args[1] === 'list') return JSON.stringify(prs);
    if (args[1] === 'create') {
      prs.push({ url: PR });
      return `${PR}\n`;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const store = await memoryStore();
  return { lead, bare, store, calls, deps: { store, config: DEFAULT_CHILDREN, accounts, gh } };
}

// Records a finished child the way the supervisor would: a worktree on its own branch with one commit.
function finishedChild(p, { files, lines = 1, outcome = 'done', exitCode = 0, repoRun = false } = {}) {
  const base = git(p.lead, 'rev-parse', 'HEAD');
  const leadSession = repoRun ? REPO_LEAD : 'lead-1';
  const brief = repoRun ? { ...BRIEF, repo: p.lead } : BRIEF;
  const run = p.store.createChildRun({ leadSession, brief, model: 'anthropic/claude-sonnet-5', repo: 'api', budgetLines: 300, budgetFiles: 8 }, `session:${leadSession}`, (id) => {
    const worktree = join(p.lead, '.pi', 'worktrees', `child-${id}`);
    const branch = `${repoRun ? 'child/lead/deadbeef' : 'child/feat/x'}/${id}`;
    addWorktree(runGit, p.lead, worktree, branch, base);
    return { worktree, branch, baseCommit: base };
  });
  writeFiles(run.worktree, files ?? { [`src/${run.id}.ts`]: 'x\n'.repeat(lines) });
  git(run.worktree, 'add', '-A');
  git(run.worktree, 'commit', '-q', '-m', `child ${run.id}`);
  p.store.endChildRun(run.id, { outcome, summary: 'Added retry', acceptance: [{ command: 'true', exitCode, summary: '' }] }, 'session:lead-1');
  return p.store.getChildRun(run.id);
}

test('merge_child refuses other leads, unfinished runs, failed acceptance, a dirty tree, the PR cap, and the default branch', async () => {
  const p = await project();
  const failing = finishedChild(p, { exitCode: 1 });
  assert.equal(await mergeChild(p.deps, 'lead-2', p.lead, failing.id), 'Refused: C-1 is not one of your implement runs.');
  assert.equal(await mergeChild(p.deps, 'lead-1', p.lead, failing.id), 'Refused: acceptance did not pass (true).');
  const incomplete = finishedChild(p, { outcome: 'incomplete' });
  assert.equal(await mergeChild(p.deps, 'lead-1', p.lead, incomplete.id), 'Refused: C-2 is incomplete; only done runs merge.');
  const big = finishedChild(p, { lines: 50 });
  const capped = { ...p.deps, config: { ...DEFAULT_CHILDREN, diffBudget: { ...DEFAULT_CHILDREN.diffBudget, prLines: 40 } } };
  assert.match(await mergeChild(capped, 'lead-1', p.lead, big.id), /^Refused: the PR would reach 50 lines \(0 on feat\/x \+ 50 from C-3\), over the 40-line cap\./);
  writeFiles(p.lead, { 'src/a.ts': 'dirty\n' });
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, big.id), /^Refused: your working tree has uncommitted changes/);
  git(p.lead, 'checkout', '-q', '--', 'src/a.ts');
  git(p.lead, 'checkout', '-q', 'main');
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, big.id), /^Refused: main is the default branch/);
  assert.deepEqual(p.calls, []);
  assert.equal(p.store.getChildRun('C-3').outcome, 'done');
});

test('merge_child merges with --no-ff, cleans up, pushes with an upstream, and opens a draft PR', async () => {
  const p = await project();
  const run = finishedChild(p);
  const text = await mergeChild(p.deps, 'lead-1', p.lead, run.id);
  assert.match(text, /^Merged C-1 into feat\/x\. Pushed and opened a draft PR: https:\/\/github\.com\/example-org\/api\/pull\/7\./);
  assert.match(text, /end with session_status needs-me and the note `ready for review: <PR URL>`/);
  assert.equal(git(p.lead, 'log', '-1', '--format=%s'), 'Merge child C-1: Add retry to fetchJira');
  assert.equal(git(p.lead, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  assert.equal(existsSync(run.worktree), false);
  assert.equal(git(p.lead, 'branch', '--list', run.branch), '');
  assert.equal(p.store.getChildRun('C-1').outcome, 'merged');
  assert.equal(p.store.listEvents().at(-1).action, 'merge');
  assert.equal(git(p.bare, 'rev-parse', 'refs/heads/feat/x'), git(p.lead, 'rev-parse', 'HEAD'));
  assert.equal(git(p.lead, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feat/x');
  assert.deepEqual(p.calls.map((call) => call.args.slice(0, 2)), [['auth', 'token'], ['pr', 'list'], ['pr', 'create']]);
  assert.deepEqual(p.calls[2].env, { GH_TOKEN: 'tok-123' });
  assert.deepEqual(p.calls[2].args, ['pr', 'create', '--draft', '--repo', 'example-org/api', '--base', 'main', '--head', 'feat/x', '--title', 'Add retry to fetchJira', '--body', 'Merged child runs:\n- C-1: Add retry to fetchJira (Added retry)']);
});

test('a second merge pushes to the existing upstream and leaves the existing draft PR', async () => {
  const p = await project();
  await mergeChild(p.deps, 'lead-1', p.lead, finishedChild(p).id);
  p.calls.length = 0;
  const text = await mergeChild(p.deps, 'lead-1', p.lead, finishedChild(p).id);
  assert.match(text, /^Merged C-2 into feat\/x\. Pushed; the draft PR now carries the new commits: https:\/\/github\.com\/example-org\/api\/pull\/7\./);
  assert.deepEqual(p.calls.map((call) => call.args[1]), ['token', 'list']);
  assert.equal(git(p.bare, 'rev-parse', 'refs/heads/feat/x'), git(p.lead, 'rev-parse', 'HEAD'));
});

test('a repo run merges twice in a reusable integration worktree while the default checkout stays unchanged', async () => {
  const p = await project();
  git(p.lead, 'checkout', '-q', 'main');
  const main = git(p.lead, 'rev-parse', 'HEAD');
  const outside = tempDir();
  const first = finishedChild(p, { repoRun: true });
  const integration = join(p.lead, '.pi', 'worktrees', 'lead-deadbeef');
  const one = await mergeChild(p.deps, REPO_LEAD, outside, first.id);
  assert.ok(one.startsWith(`Merged C-1 into lead/deadbeef at ${integration}.`));
  assert.equal(git(p.lead, 'branch', '--show-current'), 'main');
  assert.equal(git(p.lead, 'rev-parse', 'HEAD'), main);
  assert.equal(git(integration, 'branch', '--show-current'), 'lead/deadbeef');
  assert.equal(git(integration, 'log', '-1', '--format=%s'), 'Merge child C-1: Add retry to fetchJira');
  const second = finishedChild(p, { repoRun: true });
  assert.match(await mergeChild(p.deps, REPO_LEAD, outside, second.id), /^Merged C-2 into lead\/deadbeef at /);
  assert.equal(git(integration, 'log', '--format=%s', '-2').split('\n').filter((line) => line.startsWith('Merge child')).length, 2);
  assert.equal(git(p.lead, 'rev-parse', 'HEAD'), main);
  assert.equal(git(p.bare, 'rev-parse', 'refs/heads/lead/deadbeef'), git(integration, 'rev-parse', 'HEAD'));
});

test('a repo run refuses an integration branch that is configured as default', async () => {
  const p = await project();
  git(p.lead, 'checkout', '-q', 'main');
  const run = finishedChild(p, { repoRun: true });
  git(p.lead, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/lead/deadbeef');
  assert.match(await mergeChild(p.deps, REPO_LEAD, tempDir(), run.id), /^Refused: integration worktree branch lead\/deadbeef is the default branch\./);
  assert.equal(p.store.getChildRun(run.id).outcome, 'done');
});

test('without a GitHub account the local merge and push stand, and a retry creates the PR', async () => {
  const p = await project({ accounts: [] });
  const run = finishedChild(p);
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /^Merged C-1 into feat\/x\. Pushed\. No GitHub account in the work config covers example-org/);
  assert.equal(p.store.getChildRun('C-1').outcome, 'merged');
  const retry = await mergeChild({ ...p.deps, accounts: [{ user: 'work-account', orgs: ['Example-Org'] }] }, 'lead-1', p.lead, run.id);
  assert.match(retry, /^Merged C-1 into feat\/x\. Pushed and opened a draft PR/);
});

test('a failed push leaves the local merge, and the next merge_child retries it', async () => {
  const p = await project();
  const run = finishedChild(p);
  renameSync(p.bare, `${p.bare}.off`);
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /^Merged C-1 into feat\/x\. The push failed, and the local merge stands: [\s\S]+ Call merge_child C-1 again to retry\.$/);
  assert.equal(p.store.getChildRun('C-1').outcome, 'merged');
  assert.deepEqual(p.calls, []);
  renameSync(`${p.bare}.off`, p.bare);
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /Pushed and opened a draft PR/);
});

test('a merge conflict is aborted and refused, and the run stays done', async () => {
  const p = await project();
  const run = finishedChild(p, { files: { 'src/a.ts': 'child\n' } });
  writeFiles(p.lead, { 'src/a.ts': 'lead\n' });
  git(p.lead, 'commit', '-q', '-am', 'lead change');
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /^Refused: merging child\/feat\/x\/C-1 failed and was aborted: /);
  assert.equal(git(p.lead, 'status', '--porcelain'), '');
  assert.equal(p.store.getChildRun('C-1').outcome, 'done');
  assert.equal(existsSync(run.worktree), true);
});
