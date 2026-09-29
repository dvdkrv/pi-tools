import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { parseWorkConfig, childrenConfig, repoChildrenConfig, DEFAULT_CHILDREN, emptyConfig } = await load('src/work/config.ts');

const parse = (children) => parseWorkConfig(JSON.stringify({ children }));

test('without a children section, the defaults apply and nothing warns', () => {
  const { config, warnings } = parseWorkConfig('{}');
  assert.deepEqual(warnings, []);
  assert.equal(config.children, undefined);
  assert.deepEqual(childrenConfig(config), {
    defaultModel: 'anthropic/claude-sonnet-5',
    diffBudget: { defaultLines: 300, defaultFiles: 8, maxLines: 800, prLines: 2000 },
    spendCapUsd: 5,
    commandTimeoutMinutes: 10,
    warnPercent: 80,
    repos: {},
  });
  assert.equal(childrenConfig(emptyConfig()), DEFAULT_CHILDREN);
});

test('valid children settings override the defaults', () => {
  const { config, warnings } = parse({
    defaultModel: 'openai/gpt-5.6',
    diffBudget: { defaultLines: 200, defaultFiles: 5, maxLines: 600, prLines: 1500 },
    spendCapUsd: 2.5,
    commandTimeoutMinutes: 3,
    warnPercent: 75,
    repos: { 'example-repo': { ignore: ['**/generated/**', '*.lock'], expensiveCommands: ['make test$', 'tox$'] } },
  });
  assert.deepEqual(warnings, []);
  const c = childrenConfig(config);
  assert.equal(c.defaultModel, 'openai/gpt-5.6');
  assert.deepEqual(c.diffBudget, { defaultLines: 200, defaultFiles: 5, maxLines: 600, prLines: 1500 });
  assert.deepEqual([c.spendCapUsd, c.commandTimeoutMinutes, c.warnPercent], [2.5, 3, 75]);
  assert.deepEqual(c.repos['example-repo'], { ignore: ['**/generated/**', '*.lock'], expensiveCommands: ['make test$', 'tox$'] });
});

test('invalid values fall back to the defaults field by field, each with a warning', () => {
  const { config, warnings } = parse({
    defaultModel: '',
    diffBudget: { defaultLines: -1, defaultFiles: 2.5, maxLines: 'x' },
    spendCapUsd: 0,
    commandTimeoutMinutes: 5,
    warnPercent: 150,
    repos: { api: { ignore: ['ok/**', 7], expensiveCommands: ['(unclosed', 'make check$'] }, web: 'nope' },
  });
  const c = childrenConfig(config);
  assert.equal(c.defaultModel, 'anthropic/claude-sonnet-5');
  assert.deepEqual(c.diffBudget, { defaultLines: 300, defaultFiles: 8, maxLines: 800, prLines: 2000 });
  assert.deepEqual([c.spendCapUsd, c.commandTimeoutMinutes, c.warnPercent], [5, 5, 80]);
  assert.deepEqual(c.repos.api, { ignore: ['ok/**'], expensiveCommands: ['make check$'] });
  assert.deepEqual(c.repos.web, { ignore: [], expensiveCommands: [] });
  for (const field of ['defaultModel', 'defaultLines', 'defaultFiles', 'maxLines', 'spendCapUsd', 'warnPercent', 'repos.api.ignore', 'repos.api.expensiveCommands', 'repos.web']) {
    assert.ok(warnings.some((warning) => warning.startsWith('children') && warning.includes(field)), field);
  }
  assert.equal(warnings.length, 9);
});

test('a default budget above the maximum is clamped to the maximum', () => {
  const { config, warnings } = parse({ diffBudget: { defaultLines: 900 } });
  assert.equal(childrenConfig(config).diffBudget.defaultLines, 800);
  assert.deepEqual(warnings, ['children.diffBudget.defaultLines is above maxLines; using 800']);
});

test('a children section that is not an object warns once and uses the defaults', () => {
  const { config, warnings } = parse([]);
  assert.deepEqual(childrenConfig(config), DEFAULT_CHILDREN);
  assert.deepEqual(warnings, ['children must be an object; using the defaults']);
});

test('per-repository settings match the basename or owner/name, and merge', () => {
  const { config } = parse({ repos: { api: { ignore: ['a/**'] }, 'example-org/api': { expensiveCommands: ['make e2e'] }, web: { ignore: ['w/**'] } } });
  const c = childrenConfig(config);
  assert.deepEqual(repoChildrenConfig(c, 'api'), { ignore: ['a/**'], expensiveCommands: ['make e2e'] });
  assert.deepEqual(repoChildrenConfig(c, 'example-org/api'), { ignore: ['a/**'], expensiveCommands: ['make e2e'] });
  assert.deepEqual(repoChildrenConfig(c, 'payments-api'), { ignore: [], expensiveCommands: [] });
  assert.deepEqual(repoChildrenConfig(c, null), { ignore: [], expensiveCommands: [] });
});
