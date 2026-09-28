import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { inferSessionLink, autoLinkSession } = await load('src/work/linking.ts');

// A fake git: answers only the exact "cwd: args" pairs given, and fails like git outside a repository otherwise.
function gitTable(table) {
  return (cwd, args) => {
    const key = `${cwd}: ${args.join(' ')}`;
    if (!(key in table)) throw new Error(`fatal: not a git repository (${key})`);
    return table[key];
  };
}
const repo = (cwd, branch, root = cwd) => ({
  [`${cwd}: branch --show-current`]: branch,
  [`${cwd}: rev-parse --show-toplevel`]: root,
  [`${cwd}: rev-parse --path-format=absolute --git-common-dir`]: `${root}/.git`,
});

async function setup() {
  const store = await memoryStore();
  const a = store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const b = store.addItem({ project: 'misc', title: 'B', origin: 'manual' }, 'user');
  return { store, a, b };
}
const startAt = (store, id, cwd) => store.startSession({ id, file: null, cwd, name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: true });
const prLink = (store, itemId, head, repoName = 'example-org/api', number = 7) =>
  store.addLink(itemId, { kind: 'github-pr', key: `github:pr:${repoName}#${number}`, state: { detailed: true, state: 'OPEN', head } }, 'sync:github');

test('PI_WORK_ITEM wins, and an unknown item falls through to branch evidence', async () => {
  const { store, a } = await setup();
  prLink(store, a.id, 'fix-flake');
  const session = startAt(store, 's1', '/src/api');
  const git = gitTable(repo('/src/api', 'fix-flake'));
  assert.deepEqual(inferSessionLink(store, session, { env: { PI_WORK_ITEM: 'W-2' }, git }), { itemId: 'W-2', via: 'env' });
  assert.deepEqual(inferSessionLink(store, session, { env: { PI_WORK_ITEM: 'W-99' }, git }), { itemId: 'W-1', via: 'branch' });
  assert.deepEqual(inferSessionLink(store, session, { env: { PI_WORK_ITEM: 'nonsense' }, git }), { itemId: 'W-1', via: 'branch' });
});

test('a PR head branch links only within the same repository', async () => {
  const { store, a } = await setup();
  prLink(store, a.id, 'fix-flake');
  const web = startAt(store, 's2', '/src/web');
  assert.equal(inferSessionLink(store, web, { env: {}, git: gitTable(repo('/src/web', 'fix-flake')) }), undefined);
});

test('a Jira key in the branch name links, ignoring case', async () => {
  const { store, b } = await setup();
  store.addLink(b.id, { kind: 'jira', key: 'jira:ABC-12' }, 'user');
  const session = startAt(store, 's1', '/src/api');
  assert.deepEqual(inferSessionLink(store, session, { env: {}, git: gitTable(repo('/src/api', 'abc-12-retry')) }), { itemId: 'W-2', via: 'branch' });
});

test('branch evidence ignores done items', async () => {
  const { store, a } = await setup();
  prLink(store, a.id, 'fix-flake');
  store.updateItem(a.id, { status: 'done' }, 'user');
  const session = startAt(store, 's1', '/src/api');
  assert.equal(inferSessionLink(store, session, { env: {}, git: gitTable(repo('/src/api', 'fix-flake')) }), undefined);
});

test('ambiguous branch evidence links nothing, even when the worktree rule would match', async () => {
  const { store, a, b } = await setup();
  prLink(store, a.id, 'abc-12-retry');
  store.addLink(b.id, { kind: 'jira', key: 'jira:ABC-12' }, 'user');
  startAt(store, 'other', '/src/api');
  store.linkSession('other', a.id, 'manual', 'user');
  const session = startAt(store, 's1', '/src/api');
  assert.equal(inferSessionLink(store, session, { env: {}, git: gitTable(repo('/src/api', 'abc-12-retry')) }), undefined);
});

test('another linked session in the same worktree links, but a nested worktree does not count', async () => {
  const { store, a, b } = await setup();
  startAt(store, 'sub', '/src/api/pkg');
  store.linkSession('sub', a.id, 'manual', 'user');
  startAt(store, 'nested', '/src/api/.worktrees/x');
  store.linkSession('nested', b.id, 'manual', 'user');
  const session = startAt(store, 's1', '/src/api');
  const git = gitTable({
    ...repo('/src/api', 'main'),
    '/src/api/pkg: rev-parse --show-toplevel': '/src/api',
    '/src/api/.worktrees/x: rev-parse --show-toplevel': '/src/api/.worktrees/x',
  });
  assert.deepEqual(inferSessionLink(store, session, { env: {}, git }), { itemId: 'W-1', via: 'worktree' });
});

test('failing git lookups skip linking without throwing', async () => {
  const { store } = await setup();
  const session = startAt(store, 's1', '/nowhere');
  assert.equal(inferSessionLink(store, session, { env: {}, git: gitTable({}) }), undefined);
});

test('autoLinkSession links once with the session actor and never replaces an existing link', async () => {
  const { store, b } = await setup();
  startAt(store, 's1', '/src/api');
  const link = autoLinkSession(store, 's1', { env: { PI_WORK_ITEM: 'W-1' }, git: gitTable({}) });
  assert.equal(link.itemId, 'W-1');
  assert.deepEqual(link.state, { via: 'env' });
  assert.equal(store.listEvents().at(-1).actor, 'session:s1');
  store.linkSession('s1', b.id, 'manual', 'user');
  assert.equal(autoLinkSession(store, 's1', { env: { PI_WORK_ITEM: 'W-1' }, git: gitTable({}) }), undefined);
  assert.equal(store.sessionLink('s1').itemId, 'W-2');
  assert.equal(autoLinkSession(store, 'missing', { env: {}, git: gitTable({}) }), undefined);
});
