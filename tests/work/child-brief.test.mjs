import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { resolveBrief, renderChildPrompt, renderFirstPrompt } = await load('src/work/children/brief.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

test('an implement brief takes the default model and budget, and caps requested lines', () => {
  const r = resolveBrief({ goal: ' Add retry to fetchJira ', kind: 'implement', scope: ['src/**', ' '], acceptance: ['node --test tests/a.test.mjs'] }, DEFAULT_CHILDREN, 'api');
  assert.deepEqual(r.brief, { goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null, repo: null });
  assert.deepEqual([r.model, r.budgetLines, r.budgetFiles, r.notes], ['ai-gw-openai/openai/gpt-5.6-sol', 300, 8, []]);
  const capped = resolveBrief({ goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['true'], budget: { lines: 5000, files: 3 }, model: 'openai/gpt-5.6', model_reason: 'needs a long context' }, DEFAULT_CHILDREN, 'api');
  assert.deepEqual([capped.budgetLines, capped.budgetFiles, capped.model, capped.notes], [800, 3, 'openai/gpt-5.6', ['Budget capped at 800 lines.']]);
  assert.equal(capped.brief.modelReason, 'needs a long context');
});

test('a read-only brief has no budget and needs no scope or acceptance', () => {
  const r = resolveBrief({ goal: 'Map the auth flow', kind: 'read-only' }, DEFAULT_CHILDREN, null);
  assert.deepEqual([r.budgetLines, r.budgetFiles, r.brief.scope, r.brief.acceptance, r.brief.repo], [null, null, [], [], null]);
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
    [{ goal: 'x', kind: 'read-only', from: 'C-1' }, /from applies only to implement runs/],
  ];
  for (const [params, pattern] of cases) assert.match(resolveBrief(params, DEFAULT_CHILDREN, 'api').error, pattern);
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
