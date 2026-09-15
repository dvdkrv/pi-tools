import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const picker = await jiti.import('../../src/worktree/fuzzy-select.ts');

const items = [
  { name: 'alpha', description: 'first item' },
  { name: 'alphabet', description: 'letters' },
  { name: 'beta', description: 'second item' },
];

test('shared fuzzyFilter ranks compact ordered matches first', () => {
  const result = picker.fuzzyFilter(items, 'alp', {
    getSearchText: (item) => `${item.name}\n${item.description}`,
    limit: 10,
  });

  assert.deepEqual(result.map((item) => item.name), ['alpha', 'alphabet']);
});

test('shared picker custom actions preserve lowercase search input', () => {
  assert.deepEqual(picker.pickerInputAction('N', [{ key: 'N', label: 'new' }]), {
    type: 'custom',
    key: 'N',
  });
  assert.equal(picker.pickerInputAction('n', [{ key: 'N', label: 'new' }]), undefined);
});
