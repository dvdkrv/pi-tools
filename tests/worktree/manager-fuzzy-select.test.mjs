import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const mod = await jiti.import('../../src/worktree/fuzzy-select.ts');

const items = [
  { name: 'agent', branch: 'main', path: '/repos/agent' },
  { name: 'integrations-core', branch: 'feature-env', path: '/repos/integrations-core' },
  { name: 'dotfiles', branch: 'main', path: '/repos/dotfiles' },
];

test('fuzzyFilter returns first 10 items for empty query', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `worktree-${String(i).padStart(2, '0')}` }));
  assert.deepEqual(
    mod.fuzzyFilter(many, '', { getSearchText: (item) => item.name, limit: 10 }).map((item) => item.name),
    ['worktree-00', 'worktree-01', 'worktree-02', 'worktree-03', 'worktree-04', 'worktree-05', 'worktree-06', 'worktree-07', 'worktree-08', 'worktree-09'],
  );
});

test('fuzzyFilter matches non-contiguous characters and descriptions', () => {
  assert.deepEqual(
    mod.fuzzyFilter(items, 'icore', { getSearchText: (item) => `${item.name}\n${item.branch}\n${item.path}` }).map((item) => item.name),
    ['integrations-core'],
  );
  assert.deepEqual(
    mod.fuzzyFilter(items, 'env', { getSearchText: (item) => `${item.name}\n${item.branch}\n${item.path}` }).map((item) => item.name),
    ['integrations-core'],
  );
});
