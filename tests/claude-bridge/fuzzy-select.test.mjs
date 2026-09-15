import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const mod = await jiti.import('../../src/worktree/fuzzy-select.ts');

const items = [
  { name: 'systematic-debugging', description: 'Use when encountering bugs' },
  { name: 'test-driven-development', description: 'RED GREEN REFACTOR' },
  { name: 'writing-plans', description: 'Planning implementation' },
  { name: 'verification-before-completion', description: 'Evidence before claims' },
];

test('fuzzyFilter returns first 10 items for empty query', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `skill-${String(i).padStart(2, '0')}` }));
  assert.deepEqual(
    mod.fuzzyFilter(many, '', { getSearchText: (item) => item.name, limit: 10 }).map((item) => item.name),
    ['skill-00', 'skill-01', 'skill-02', 'skill-03', 'skill-04', 'skill-05', 'skill-06', 'skill-07', 'skill-08', 'skill-09'],
  );
});

test('fuzzyFilter matches non-contiguous characters in order', () => {
  assert.deepEqual(
    mod.fuzzyFilter(items, 'sdbg', { getSearchText: (item) => `${item.name}\n${item.description}` }).map((item) => item.name),
    ['systematic-debugging'],
  );
});

test('fuzzyFilter searches descriptions as well as labels', () => {
  assert.deepEqual(
    mod.fuzzyFilter(items, 'evidence', { getSearchText: (item) => `${item.name}\n${item.description}` }).map((item) => item.name),
    ['verification-before-completion'],
  );
});

test('fuzzyFilter ranks compact matches before weak matches', () => {
  const ranked = mod.fuzzyFilter([
    { name: 'alpha-test-driven-development' },
    { name: 'test-driven-development' },
    { name: 'totally-different-dev' },
  ], 'tdd', { getSearchText: (item) => item.name });

  assert.equal(ranked[0].name, 'test-driven-development');
});
