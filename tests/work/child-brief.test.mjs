import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { resolveBrief, renderChildPrompt, renderFirstPrompt } = await load('src/work/children/brief.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

test('an implement brief takes the default model and budget, and caps requested lines', () => {
  const r = resolveBrief({ goal: ' Add retry to fetchJira ', kind: 'implement', scope: ['src/**', ' '], acceptance: ['node --test tests/a.test.mjs'] }, DEFAULT_CHILDREN, 'api');
  assert.deepEqual(r.brief, { goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null, repo: null });
  assert.deepEqual([r.model, r.budgetLines, r.budgetFiles, r.notes], ['ai-gw-openai/openai/gpt-5.6-sol', 300, 8, []]);
  const capped = resolveBrief({ goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['true'], budget: { lines: 5000, files: 3 }, model: 'ai-gw-openai/openai/gpt-5.5', model_reason: 'needs a long context' }, DEFAULT_CHILDREN, 'api');
  assert.deepEqual([capped.budgetLines, capped.budgetFiles, capped.model, capped.notes], [800, 3, 'ai-gw-openai/openai/gpt-5.5', ['Budget capped at 800 lines.']]);
  assert.equal(capped.brief.modelReason, 'needs a long context');
});

test('a read-only brief has no budget and needs no scope or acceptance', () => {
  const r = resolveBrief({ goal: 'Map the auth flow', kind: 'read-only' }, DEFAULT_CHILDREN, null);
  assert.deepEqual([r.budgetLines, r.budgetFiles, r.brief.scope, r.brief.acceptance, r.brief.repo], [null, null, [], [], null]);
  // Some models fill every parameter; from cannot apply to a run without a branch, so it is dropped with a note, not refused.
  const filled = resolveBrief({ goal: 'Review the RFC', kind: 'read-only', from: 'C-40', budget: { lines: 1, files: 1 } }, DEFAULT_CHILDREN, null);
  assert.deepEqual([filled.error, filled.brief.from, filled.budgetLines, filled.notes], [undefined, null, null, ['Ignored from C-40: read-only runs always start fresh.']]);
});

test('invalid briefs are refused with a reason', () => {
  const base = { goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['true'] };
  const cases = [
    [{ ...base, goal: '' }, /goal must be one sentence/],
    [{ ...base, goal: 'a\nb' }, /goal must be one sentence/],
    [{ ...base, goal: 'x'.repeat(201) }, /goal must be one sentence/],
    [{ ...base, kind: 'refactor' }, /kind must be implement or read-only/],
    [{ ...base, scope: [] }, /implement needs scope/],
    [{ ...base, acceptance: [] }, /implement needs acceptance/],
    [{ ...base, acceptance: ['pytest -q'] }, /acceptance command `pytest -q` is not allowed\. Blocked: repository-wide test run/],
    [{ ...base, acceptance: ['git push'] }, /Blocked: git push/],
    [{ ...base, context: 'x'.repeat(4001) }, /context must be at most 4000 characters/],
    [{ ...base, model: 'openai/gpt-5.6' }, /model needs model_reason/],
    [{ ...base, budget: { lines: 0 } }, /budget lines and files must be positive integers/],
  ];
  for (const [params, pattern] of cases) assert.match(resolveBrief(params, DEFAULT_CHILDREN, 'api').error, pattern);
});

test('a model outside children.allowedModels is refused, with the gateway alternative when there is one', () => {
  const base = { goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['true'], model_reason: 'test' };
  assert.equal(
    resolveBrief({ ...base, model: 'anthropic/claude-opus-5' }, DEFAULT_CHILDREN, 'api').error,
    'model anthropic/claude-opus-5 is not allowed (children.allowedModels: ai-gw-*); use ai-gw-anthropic-200k/anthropic/claude-opus-5',
  );
  assert.equal(
    resolveBrief({ ...base, model: 'gpt-5.6' }, DEFAULT_CHILDREN, 'api').error,
    'model gpt-5.6 is not allowed (children.allowedModels: ai-gw-*); use ai-gw-openai/openai/gpt-5.6',
  );
  assert.equal(resolveBrief({ ...base, model: 'local/llama' }, DEFAULT_CHILDREN, 'api').error, 'model local/llama is not allowed (children.allowedModels: ai-gw-*)');
  const refusedDefault = { ...DEFAULT_CHILDREN, defaultModel: 'openai/gpt-5.6' };
  assert.equal(
    resolveBrief({ goal: 'x', kind: 'read-only' }, refusedDefault, null).error,
    'model openai/gpt-5.6 (children.defaultModel) is not allowed (children.allowedModels: ai-gw-*); use ai-gw-openai/openai/gpt-5.6',
  );
  const open = { ...DEFAULT_CHILDREN, allowedModels: ['openai/*'] };
  assert.equal(resolveBrief({ ...base, model: 'openai/gpt-5.6' }, open, 'api').error, undefined);
  assert.equal(resolveBrief({ ...base, model: 'anthropic/claude-opus-5' }, open, 'api').error, 'model anthropic/claude-opus-5 is not allowed (children.allowedModels: openai/*)');
});

test('per-repository expensive commands also apply to acceptance', () => {
  const config = { ...DEFAULT_CHILDREN, repos: { api: { ignore: [], expensiveCommands: ['^make e2e$'] } } };
  const params = { goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['make e2e'] };
  assert.match(resolveBrief(params, config, 'api').error, /repository-wide/);
  assert.equal(resolveBrief(params, config, 'web').error, undefined);
});

test('the child prompt states the brief and the rules, and the first prompt points to it', () => {
  const { brief } = resolveBrief({ goal: 'Add retry', kind: 'implement', scope: ['src/**'], non_goals: ['No new config'], acceptance: ['node --test tests/a.test.mjs'], context: 'fetchJira is in src/jira.ts' }, DEFAULT_CHILDREN, 'api');
  const text = renderChildPrompt({ id: 'C-4', brief, budgetLines: 300, budgetFiles: 8, branch: 'child/feat/C-4' }, DEFAULT_CHILDREN);
  for (const part of ['# Child run C-4', 'Goal: Add retry', 'Scope (the only paths you may change): src/**', 'Non-goals: No new config', '- `node --test tests/a.test.mjs`', 'fetchJira is in src/jira.ts', 'Less is more', 'Diff budget: 300 lines and 8 files', 'child/feat/C-4', 'Spending cap: $5.00', 'End with session_status']) {
    assert.ok(text.includes(part), part);
  }
  const readOnly = renderChildPrompt({ id: 'C-5', brief: resolveBrief({ goal: 'Map it', kind: 'read-only' }, DEFAULT_CHILDREN, null).brief, budgetLines: null, budgetFiles: null, branch: null }, DEFAULT_CHILDREN);
  assert.match(readOnly, /read-only: edit and write are disabled/);
  assert.doesNotMatch(readOnly, /Diff budget/);
  assert.equal(renderFirstPrompt(brief), 'Start on your brief (in the system prompt): Add retry');
});
