import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, DAY, load, memoryStore } from './helpers.mjs';

const triage = await load('src/work/triage.ts');

async function setup(now = clock()) {
  const store = await memoryStore(now);
  store.upsertProject({ slug: 'payments', title: 'Payments' }, 'user');
  return store;
}

const githubCandidate = (store, n = 1) => store.addCandidate({
  kind: 'new-item', source: 'github', query: 'review-requested:example-org', dedupeKey: `github:pr:example-org/api#${n}`,
  title: `Review example-org/api#${n}: change`, reason: 'Review requested', evidence: `https://github.com/example-org/api/pull/${n}`,
  proposedProject: 'payments', payload: { link: { kind: 'github-pr', key: `github:pr:example-org/api#${n}`, url: `https://github.com/example-org/api/pull/${n}`, state: { detailed: false, state: 'OPEN' } } },
}, 'sync:github');

test('accepting a connector candidate creates an item with its link', async () => {
  const store = await setup();
  const c = githubCandidate(store);
  const item = triage.acceptCandidate(store, c.id, { title: 'Review API change' });
  assert.equal(item.title, 'Review API change');
  assert.equal(item.project, 'payments');
  assert.equal(item.origin, 'github');
  assert.equal(store.listLinks(item.id)[0].key, 'github:pr:example-org/api#1');
  assert.equal(store.getCandidate(c.id).state, 'accepted');
  assert.throws(() => triage.acceptCandidate(store, c.id), /already accepted/);
});

test('agent candidates keep reason and evidence, and a URL in the evidence becomes a link', async () => {
  const store = await setup();
  const c = store.addCandidate({
    kind: 'new-item', source: 'agent', dedupeKey: 'agent:api:flaky', title: 'Fix flaky test', reason: 'Seen twice in CI',
    evidence: 'https://github.com/example-org/api/issues/5', proposedProject: 'payments', proposer: { sessionId: 's1', repo: 'api' },
  }, 'agent:s1');
  const item = triage.acceptCandidate(store, c.id);
  assert.equal(item.origin, 'agent');
  assert.match(item.notes, /Seen twice in CI/);
  assert.equal(store.listLinks(item.id)[0].kind, 'github-issue');
});

test('attach-link candidates merge into their related item, and merge works explicitly', async () => {
  const store = await setup();
  const target = store.addItem({ project: 'payments', title: 'Ship', origin: 'manual' }, 'user');
  const attach = store.addCandidate({ kind: 'attach-link', source: 'github', dedupeKey: 'github:pr:example-org/api#2', title: 't', reason: 'r', relatesTo: target.id,
    payload: { link: { kind: 'github-pr', key: 'github:pr:example-org/api#2', url: 'u2', state: null } } }, 'sync:github');
  triage.acceptCandidate(store, attach.id);
  assert.equal(store.getCandidate(attach.id).state, 'merged');
  const other = githubCandidate(store, 3);
  triage.mergeCandidate(store, other.id, target.id);
  assert.deepEqual(store.listLinks(target.id).map((l) => l.key), ['github:pr:example-org/api#2', 'github:pr:example-org/api#3']);
});

test('dismiss records the key, and snooze hides until due', async () => {
  const now = clock();
  const store = await setup(now);
  const a = githubCandidate(store, 1);
  const b = githubCandidate(store, 2);
  triage.dismissCandidate(store, a.id);
  assert.equal(store.isDismissed(a.dedupeKey), true);
  triage.snoozeCandidate(store, b.id, 2);
  assert.equal(triage.openCandidates(store).length, 0);
  now.advance(2 * DAY);
  assert.deepEqual(triage.openCandidates(store).map((c) => c.id), [b.id]);
  assert.throws(() => triage.snoozeCandidate(store, b.id, 0), /between 1 and 90/);
});

test('bulk accept takes one source and skips Jira updates', async () => {
  const store = await setup();
  githubCandidate(store, 1);
  githubCandidate(store, 2);
  store.addCandidate({ kind: 'jira-update', source: 'github', dedupeKey: 'jira-update:ABC-1:done', title: 'Move', reason: 'merged', payload: { ticket: 'ABC-1', targetCategory: 'done' } }, 'sync:github');
  const items = triage.acceptAllFromSource(store, 'github');
  assert.equal(items.length, 2);
  const [left] = triage.openCandidates(store);
  assert.equal(left.kind, 'jira-update');
  assert.throws(() => triage.acceptCandidate(store, left.id), /applyJiraUpdate/);
  assert.match(triage.candidateDetails(left, 1), /\[github\] jira-update Move/);
});
