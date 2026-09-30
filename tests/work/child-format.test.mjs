import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { renderResult } = await load('src/work/children/format.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

const run = (overrides = {}) => ({
  id: 'C-3', leadSession: 'lead-1', childSession: null, kind: 'implement', brief: { goal: 'Add retry', acceptance: [], scope: ['src'] },
  model: 'ai-gw-openai/openai/gpt-5.6-sol', repo: null, worktree: '/r/.pi/worktrees/child-C-3', branch: 'child/feat/C-3', baseCommit: 'abcdef1234567890',
  pid: null, outcome: 'incomplete', flags: [], spendUsd: 0, diffLines: 4, diffFiles: 1, budgetLines: 300, budgetFiles: 8,
  acceptance: [], summary: '', createdAt: '', endedAt: null, mergedAt: null, ...overrides,
});

test('a result for a live run offers to continue or discard', () => {
  const text = renderResult(run(), DEFAULT_CHILDREN);
  assert.match(text, /Next: delegate again with from: C-3/);
  assert.match(text, /Branch: child\/feat\/C-3/);
});

test('a late result for a discarded or merged run does not offer to delegate again or discard', () => {
  const discarded = renderResult(run({ outcome: 'discarded' }), DEFAULT_CHILDREN);
  assert.match(discarded, /^Child C-3 finished: discarded/);
  assert.doesNotMatch(discarded, /delegate again|discard: true|Branch:/);
  assert.match(discarded, /already discarded, so there is nothing left to do/);
  const merged = renderResult(run({ outcome: 'merged' }), DEFAULT_CHILDREN);
  assert.doesNotMatch(merged, /delegate again|discard: true|merge_child/);
  assert.match(merged, /already merged/);
});
