import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { projectFor, repoFromCwd, jiraKeysIn, itemForKeys, itemWithoutJiraByTitle } = await load('src/work/rules.ts');

const rules = [
  { repo: 'payments-api', project: 'payments' },
  { jiraEpic: 'ABC-100', project: 'payments' },
  { jiraProject: 'OPS', project: 'ops' },
  { repo: 'ghost', project: 'unknown-project' },
];
const known = new Set(['misc', 'payments', 'ops']);

test('projectFor matches repo by name or owner/name, epic, and Jira project', () => {
  assert.equal(projectFor({ repo: 'payments-api' }, rules, known), 'payments');
  assert.equal(projectFor({ repo: 'example-org/payments-api' }, rules, known), 'payments');
  assert.equal(projectFor({ jiraEpic: 'ABC-100' }, rules, known), 'payments');
  assert.equal(projectFor({ jiraProject: 'OPS' }, rules, known), 'ops');
  assert.equal(projectFor({ repo: 'ghost' }, rules, known), 'misc');
  assert.equal(projectFor({}, rules, known), 'misc');
});

test('repoFromCwd uses the common git dir so worktrees map to their repository', () => {
  const git = (_cwd, args) => {
    assert.deepEqual(args, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return '/src/payments-api/.git';
  };
  assert.equal(repoFromCwd('/src/payments-api/.pi/worktrees/fix', git), 'payments-api');
  assert.equal(repoFromCwd('/tmp', () => { throw new Error('not a repo'); }), undefined);
});

test('jiraKeysIn extracts unique keys', () => {
  assert.deepEqual(jiraKeysIn('ABC-12 fix, see ABC-12 and OPS-3; not abc-1'), ['ABC-12', 'OPS-3']);
});

test('duplicate lookups find items by link key or by exact title without a Jira link', async () => {
  const store = await memoryStore();
  const a = store.addItem({ project: 'misc', title: 'Fix flaky test', origin: 'manual' }, 'user');
  store.addLink(a.id, { kind: 'jira', key: 'jira:ABC-1' }, 'user');
  const b = store.addItem({ project: 'misc', title: 'Write docs', origin: 'manual' }, 'user');
  assert.equal(itemForKeys(store, ['jira:NOPE-1', 'jira:ABC-1']), a.id);
  assert.equal(itemWithoutJiraByTitle(store, '  write DOCS '), b.id);
  assert.equal(itemWithoutJiraByTitle(store, 'Fix flaky test'), undefined);
});
