import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const task = await jiti.import('../../extensions/task.ts');

test('task extension registers only the user-invoked /task command', () => {
  const commands = [];
  const tools = [];
  task.default({
    registerCommand(name, options) {
      commands.push({ name, description: options.description, handler: options.handler });
    },
    registerTool(definition) {
      tools.push(definition);
    },
  });

  assert.deepEqual(commands.map((command) => command.name), ['task']);
  assert.deepEqual(tools, []);
});

test('parseTaskConfig accepts an optional model override', () => {
  assert.deepEqual(task.parseTaskConfig('{"model":"openai/gpt-5.5"}'), {
    model: 'openai/gpt-5.5',
    warnings: [],
  });
  assert.deepEqual(task.parseTaskConfig('{"model":3}'), {
    warnings: ['model must be a provider/model string'],
  });
});

test('/task rejects non-TUI invocation before performing task inference', async () => {
  let handler;
  task.default({
    registerCommand(_name, options) {
      handler = options.handler;
    },
    registerTool() {
      assert.fail('task tool must not be registered');
    },
  });
  const notifications = [];

  await handler('review this repository', {
    mode: 'rpc',
    cwd: '/not/a/repo',
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  });

  assert.deepEqual(notifications, [{
    message: '/task is available only in interactive TUI mode',
    level: 'error',
  }]);
});

test('parseTaskArgs removes --split before model inference', () => {
  assert.deepEqual(task.parseTaskArgs('--split fix flaky e2e framework tests'), {
    request: 'fix flaky e2e framework tests',
    split: true,
  });
  assert.deepEqual(task.parseTaskArgs('fix flaky e2e framework tests'), {
    request: 'fix flaky e2e framework tests',
    split: false,
  });
});

test('buildTaskInferencePrompt includes freeform request and candidate repos', () => {
  const prompt = task.buildTaskInferencePrompt('fix flaky e2e framework tests', [
    { alias: 'dotfiles', root: '/repos/dotfiles' },
    { alias: 'integrations-core', root: '/repos/integrations-core' },
  ]);

  assert.match(prompt, /fix flaky e2e framework tests/);
  assert.match(prompt, /integrations-core/);
  assert.match(prompt, /Return only JSON/);
  assert.match(prompt, /baseRef/);
  assert.match(prompt, /Omit baseRef unless/);
});

test('parseTaskInference accepts fenced JSON and normalizes the worktree name', () => {
  const parsed = task.parseTaskInference('```json\n{"repoAlias":"integrations-core","goal":"Fix flaky e2e framework tests","worktreeName":"Fix Flaky E2E Framework","kickoffPrompt":"Investigate and fix the flaky e2e framework tests.","baseRef":"feature/flaky-repro"}\n```');

  assert.deepEqual(parsed, {
    repoAlias: 'integrations-core',
    goal: 'Fix flaky e2e framework tests',
    worktreeName: 'fix-flaky-e2e-framework',
    kickoffPrompt: 'Investigate and fix the flaky e2e framework tests.',
    baseRef: 'feature/flaky-repro',
  });
});

test('parseTaskInference omits baseRef when the request did not specify one', () => {
  const parsed = task.parseTaskInference('{"repoAlias":"integrations-core","goal":"Fix flaky e2e framework tests","worktreeName":"Fix Flaky E2E Framework","kickoffPrompt":"Investigate and fix the flaky e2e framework tests."}');

  assert.equal(parsed.baseRef, undefined);
});

test('buildKickoffPrompt includes goal context constraints original request and base ref', () => {
  const prompt = task.buildKickoffPrompt({
    originalRequest: 'fix flaky e2e framework tests from branch feature/flaky-repro',
    repo: { alias: 'integrations-core', root: '/repos/integrations-core' },
    goal: 'Fix flaky e2e framework tests',
    kickoffPrompt: 'Inspect recent e2e framework failures and propose a fix.',
    baseRef: 'feature/flaky-repro',
  });

  assert.match(prompt, /Goal: Fix flaky e2e framework tests/);
  assert.match(prompt, /Repository: integrations-core/);
  assert.match(prompt, /Original request: fix flaky e2e framework tests from branch feature\/flaky-repro/);
  assert.match(prompt, /Base ref: feature\/flaky-repro/);
  assert.match(prompt, /Use the relevant Pi skills/);
});

test('buildTaskLaunchCommand marks task sessions for auto cleanup', () => {
  const launch = task.buildTaskLaunchCommand({ name: 'fix-flaky', path: '/repo/.pi/worktrees/fix-flaky' }, 'Fix flaky test', { split: false, insideTmux: true });

  assert.equal(launch.args.at(-1), "PI_WORKTREE_AUTO_CLEANUP=1 pi 'Fix flaky test'");
});

test('reviewInputAction maps Enter E and Escape', () => {
  assert.deepEqual(task.reviewInputAction('\r'), { type: 'launch' });
  assert.deepEqual(task.reviewInputAction('E'), { type: 'edit' });
  assert.deepEqual(task.reviewInputAction('\u001b'), { type: 'cancel' });
  assert.equal(task.reviewInputAction('x'), undefined);
});
