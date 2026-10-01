import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { sessionDisplayName, stripMarkdown } = await load('src/work/display.ts');

test('a default tmux window name gives way to the repository, then the cwd basename', () => {
  assert.equal(sessionDisplayName('api-fix', 'payments-api', '/src/payments-api'), 'api-fix');
  for (const name of ['pi', 'zsh', 'bash', '', null]) assert.equal(sessionDisplayName(name, 'payments-api', '/src/wt/v2'), 'payments-api', String(name));
  assert.equal(sessionDisplayName('pi', null, '/src/wt/v2'), 'v2');
});

test('stripMarkdown keeps the words of a note and drops its markup', () => {
  assert.equal(stripMarkdown('**Merge** `C-3`? See [PR 12](https://x/12) and _docs_'), 'Merge C-3? See PR 12 and docs');
  assert.equal(stripMarkdown('## Heading'), 'Heading');
  assert.equal(stripMarkdown('- item one\n> quoted\n1. first'), 'item one\nquoted\nfirst');
  assert.equal(stripMarkdown('~~old~~ *new* ![img](a.png)'), 'old new img');
  assert.equal(stripMarkdown('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
});
