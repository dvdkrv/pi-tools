import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, gitRepo, load, memoryRuntime, readJsonl, tempDir, until, writeFiles } from './helpers.mjs';

const { createSupervisor } = await load('src/work/children/supervisor.ts');
const { lastLine, modelShortName } = await load('src/work/children/format.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

const FAKE = fileURLToPath(new URL('./fixtures/fake-rpc-child.mjs', import.meta.url));
const COMMIT = { file: 'src/retry.ts', text: 'export const retry = 1;\n' };
const implement = (overrides = {}) => ({ goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], acceptance: ['test -f src/retry.ts'], ...overrides });
const commandsIn = (log) => readJsonl(log).filter((entry) => entry.command).map((entry) => entry.command.type);

// A lead repository on feat/x, the child's session row, and a supervisor whose children are the fake.
async function lead({ behavior = {}, declared = 'done', note = 'Added retry', command } = {}) {
  const rt = await memoryRuntime();
  const repo = gitRepo({ 'src/a.ts': 'one\n', 'README.md': 'hi\n' });
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  const log = join(tempDir(), 'child.jsonl');
  const messages = [];
  rt.store.startSession({ id: 'child-s1', file: null, cwd: repo, name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: 'lead-1', headless: true });
  if (declared) rt.store.setSessionStatus('child-s1', declared, note, 'agent');
  const supervisor = createSupervisor({
    store: () => rt.store,
    config: () => DEFAULT_CHILDREN,
    notify: (text) => messages.push(text),
    command: command ?? [process.execPath, FAKE],
    env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify({ sessionId: 'child-s1', ...behavior }), FAKE_CHILD_LOG: log },
    pid: 4242,
    killGraceMs: 200,
  });
  return { rt, store: rt.store, repo, log, messages, supervisor };
}

test('delegate starts an implement child in its own worktree and reports one done result', async () => {
  const l = await lead({ behavior: { commit: COMMIT } });
  const item = l.store.addItem({ project: 'misc', title: 'Retry', origin: 'manual' }, 'user');
  l.store.startSession({ id: 'lead-1', file: null, cwd: l.repo, name: null, pid: 2, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: false });
  l.store.linkSession('lead-1', item.id, 'manual', 'user');
  const head = git(l.repo, 'rev-parse', 'HEAD');
  const result = l.supervisor.delegate('lead-1', l.repo, implement());
  assert.equal(result.ok, true);
  assert.deepEqual([result.run.id, result.run.branch, result.run.baseCommit], ['C-1', 'child/feat/x/C-1', head]);
  assert.equal(result.run.worktree, join(l.repo, '.pi', 'worktrees', 'child-C-1'));
  assert.match(result.message, /^Started C-1 on child\/feat\/x\/C-1 with anthropic\/claude-sonnet-5\. Its result arrives as a message/);
  assert.equal(git(l.repo, 'status', '--porcelain'), '');

  await until(() => l.messages.length === 1);
  const run = l.store.getChildRun('C-1');
  assert.deepEqual([run.outcome, run.childSession, run.summary, run.diffLines, run.diffFiles], ['done', 'child-s1', 'Added retry', 1, 1]);
  assert.deepEqual(run.acceptance, [{ command: 'test -f src/retry.ts', exitCode: 0, summary: '' }]);
  assert.match(l.messages[0], /^Child C-1 finished: done\nGoal: Add retry to fetchJira\nSummary: Added retry\nDiff: 1\/300 lines, 1\/8 files\nAcceptance: pass `test -f src\/retry\.ts` \(exit 0\)\nSpend: \$0\.00 of \$5\.00\nBranch: child\/feat\/x\/C-1 \(base [0-9a-f]{12}\)\nNext: review the diff/);
  assert.match(l.messages[0], /call merge_child C-1/);
  assert.equal(l.supervisor.list('lead-1'), 'C-1  done  sonnet-5  $0.00  1/300 lines 1/8 files  acceptance 1/1  goal: Add retry to fetchJira  note: Added retry');

  const entries = await until(() => {
    const logged = readJsonl(l.log);
    return logged.some((entry) => entry.stdin === 'closed' || entry.signal === 'SIGTERM') && logged;
  });
  const [start] = entries;
  assert.deepEqual(start.argv.slice(0, 7), ['--mode', 'rpc', '--model', 'anthropic/claude-sonnet-5', '--name', 'child C-1: Add retry to fetchJira', '--append-system-prompt']);
  assert.match(start.argv[7], /Scope \(the only paths you may change\): src\/\*\*/);
  assert.equal(start.argv.length, 8);
  assert.equal(start.cwd, run.worktree);
  assert.deepEqual(start.env, { PI_WORK_CHILD_RUN: 'C-1', PI_WORK_ITEM: 'W-1', PI_WORK_PARENT_PID: '4242', PI_WORK_PARENT_SESSION: 'lead-1' });
  assert.deepEqual(commandsIn(l.log), ['get_state', 'prompt']);
});

test('delegate refuses a dirty tree, the default branch, and invalid briefs, and a failed worktree records no run', async () => {
  const l = await lead();
  writeFiles(l.repo, { 'src/a.ts': 'changed\n' });
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement()).message, /^Refused: your working tree has uncommitted changes/);
  git(l.repo, 'checkout', '-q', '--', 'src/a.ts');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ scope: [] })).message, /^Refused: implement needs scope/);
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ acceptance: ['npm test'] })).message, /repository-wide test run/);
  git(l.repo, 'branch', 'child/feat/x/C-1');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement()).message, /^Refused: could not create the child run: .*already exists/);
  assert.deepEqual(l.store.listChildRuns(), []);
  git(l.repo, 'checkout', '-q', 'main');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement()).message, /^Refused: main is the default branch/);
  assert.equal(existsSync(l.log), false);
});

test('a child that settles without declaring done is incomplete, and acceptance does not run', async () => {
  const l = await lead({ behavior: { commit: COMMIT }, declared: null });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const run = l.store.getChildRun('C-1');
  assert.equal(run.outcome, 'incomplete');
  assert.deepEqual(run.acceptance, []);
  assert.match(l.messages[0], /^Child C-1 finished: incomplete[\s\S]*delegate again with from: C-1/);
});

test('a crash after the prompt fails the run and keeps the worktree', async () => {
  const l = await lead({ behavior: { onPrompt: 'exit', exitCode: 3, stderr: 'boom: provider unreachable\n' } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const run = l.store.getChildRun('C-1');
  assert.equal(run.outcome, 'failed');
  assert.equal(run.summary, 'exited: code 3; boom: provider unreachable');
  assert.equal(existsSync(run.worktree), true);
  assert.match(l.messages[0], /^Child C-1 finished: failed/);
});

test('a child that cannot start fails the run and removes its worktree and branch', async () => {
  const l = await lead({ command: ['/nonexistent/pi'] });
  const { run } = l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const ended = l.store.getChildRun('C-1');
  assert.equal(ended.outcome, 'failed');
  assert.match(ended.summary, /^failed to start: .*ENOENT/);
  assert.equal(existsSync(run.worktree), false);
  assert.equal(git(l.repo, 'branch', '--list', 'child/feat/x/C-1'), '');
});

test('a read-only child runs in the lead directory without edit and write, and is done when it declares done', async () => {
  const l = await lead({ note: 'Auth goes through src/auth.ts' });
  const result = l.supervisor.delegate('lead-1', l.repo, { goal: 'Map the auth flow', kind: 'read-only' });
  assert.match(result.message, /^Started C-1 \(read-only, in your working directory\) with anthropic\/claude-sonnet-5\./);
  await until(() => l.messages.length === 1);
  assert.equal(l.store.getChildRun('C-1').outcome, 'done');
  assert.doesNotMatch(l.messages[0], /Diff:/);
  assert.match(l.messages[0], /Summary: Auth goes through src\/auth\.ts/);
  const [start] = readJsonl(l.log);
  assert.equal(start.cwd, l.repo);
  assert.deepEqual(start.argv.slice(-2), ['--exclude-tools', 'edit,write']);
});

test('format helpers shorten model names and keep the last output line', () => {
  assert.equal(modelShortName('anthropic/claude-sonnet-5'), 'sonnet-5');
  assert.equal(modelShortName('openai/gpt-5.6'), 'gpt-5.6');
  assert.equal(lastLine('running 3 tests\n\x1b[32mpass 3\x1b[0m\n\n'), '[32mpass 3 [0m');
  assert.equal(lastLine(''), '');
});

const promptSent = (l) => until(() => commandsIn(l.log).includes('prompt'));

test('steer_child sends an urgent steer or a follow-up, and a settled over-budget child reports over-budget', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang', settleOnFollowUp: true } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  assert.match(await l.supervisor.steer('lead-1', 'C-1', 'Use exponential backoff', true), /^Steered C-1/);
  l.store.updateChildRun('C-1', { flags: ['over-budget'] });
  assert.match(await l.supervisor.steer('lead-1', 'C-1', 'Wrap up', false), /^Queued for C-1/);
  await until(() => l.messages.length === 1);
  assert.equal(l.store.getChildRun('C-1').outcome, 'over-budget');
  const sent = readJsonl(l.log).filter((entry) => ['steer', 'follow_up'].includes(entry.command?.type)).map((entry) => [entry.command.type, entry.command.message]);
  assert.deepEqual(sent, [['steer', 'Use exponential backoff'], ['follow_up', 'Wrap up']]);
  assert.match(await l.supervisor.steer('lead-1', 'C-1', 'more', false), /^C-1 is over-budget and can no longer be steered\. Delegate again with from: C-1/);
  assert.match(await l.supervisor.steer('lead-2', 'C-1', 'x', false), /^C-1 is not one of your child runs/);
});

test('stop_child aborts and ends the child without a message, and discard removes its worktree and branch', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang' } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  assert.match(await l.supervisor.stop('lead-1', 'C-1', false), /^Stopped C-1\. Its worktree and branch are kept \(child\/feat\/x\/C-1\)\./);
  const run = l.store.getChildRun('C-1');
  assert.equal(run.outcome, 'stopped');
  assert.equal(existsSync(run.worktree), true);
  assert.ok(commandsIn(l.log).includes('abort'));
  assert.throws(() => process.kill(run.pid, 0), /ESRCH/);
  assert.match(await l.supervisor.stop('lead-1', 'C-1', false), /^C-1 already ended as stopped/);
  assert.equal(await l.supervisor.stop('lead-1', 'C-1', true), 'Discarded C-1: removed its worktree and branch.');
  assert.equal(l.store.getChildRun('C-1').outcome, 'discarded');
  assert.equal(existsSync(run.worktree), false);
  assert.equal(git(l.repo, 'branch', '--list', 'child/feat/x/C-1'), '');
  assert.equal(await l.supervisor.stop('lead-1', 'C-1', true), 'C-1 is already discarded.');
  assert.deepEqual(l.messages, []);
});

test('a child stopped from the dashboard is reported to the lead once', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang' } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  l.store.endChildRun('C-1', { outcome: 'stopped', summary: 'stopped from the dashboard' }, 'user');
  process.kill(l.store.getChildRun('C-1').pid, 'SIGTERM');
  await until(() => l.messages.length === 1);
  assert.match(l.messages[0], /^Child C-1 finished: stopped\nGoal: Add retry to fetchJira\nSummary: stopped from the dashboard/);
});

test('shutdownAll ends even a stubborn child and leaves its run for recovery', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang', ignoreStdinClose: true, ignoreTerm: true } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  await l.supervisor.shutdownAll();
  const log = readJsonl(l.log);
  assert.ok(log.some((entry) => entry.stdin === 'closed'));
  assert.ok(log.some((entry) => entry.signal === 'SIGTERM'));
  assert.throws(() => process.kill(l.store.getChildRun('C-1').pid, 0), /ESRCH/);
  assert.equal(l.store.getChildRun('C-1').outcome, 'running');
  assert.deepEqual(l.messages, []);
  const restarted = createSupervisor({ store: () => l.store, config: () => DEFAULT_CHILDREN, notify: () => {} });
  assert.deepEqual(restarted.recover('lead-1').map((run) => [run.id, run.outcome]), [['C-1', 'interrupted']]);
  assert.deepEqual(restarted.recover('lead-1'), []);
});

test('recover signals only a PID whose environment names the run', async () => {
  const rt = await memoryRuntime();
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const brief = { goal: 'Map the auth flow', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };
  for (const pid of [sleeper.pid, 999_999]) {
    const run = rt.store.createChildRun({ leadSession: 'lead-1', brief, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:lead-1');
    rt.store.updateChildRun(run.id, { pid });
  }
  const readers = { kill: () => {}, environ: (pid) => (pid === sleeper.pid ? 'HOME=/h\0PI_WORK_CHILD_RUN=C-1\0' : undefined) };
  const supervisor = createSupervisor({ store: () => rt.store, config: () => DEFAULT_CHILDREN, notify: () => {}, readers });
  assert.deepEqual(supervisor.recover('lead-1').map((run) => run.id), ['C-1', 'C-2']);
  await until(() => sleeper.signalCode === 'SIGTERM');
});

test('from continues an earlier run: the new worktree starts at its branch, and the old run is discarded', async () => {
  const l = await lead({ behavior: { commit: COMMIT }, declared: null });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const first = l.store.getChildRun('C-1');
  assert.equal(first.outcome, 'incomplete');
  writeFiles(first.worktree, { 'src/extra.ts': 'x\n' });
  const tip = git(first.worktree, 'rev-parse', 'HEAD');
  const second = l.supervisor.delegate('lead-1', l.repo, implement({ from: 'C-1' }));
  assert.equal(second.ok, true);
  assert.equal(second.run.baseCommit, first.baseCommit);
  assert.equal(git(second.run.worktree, 'rev-parse', 'HEAD~1'), tip);
  assert.equal(git(second.run.worktree, 'log', '-1', '--format=%s'), 'WIP: uncommitted work from C-1');
  assert.equal(l.store.getChildRun('C-1').outcome, 'discarded');
  assert.equal(existsSync(first.worktree), false);
  assert.equal(git(l.repo, 'branch', '--list', 'child/feat/x/C-1'), '');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ from: 'C-1' })).message, /^Refused: C-1 is discarded\./);
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ from: 'C-7' })).message, /^Refused: C-7 is not one of your implement runs\./);
  await until(() => l.messages.length === 2);
});
