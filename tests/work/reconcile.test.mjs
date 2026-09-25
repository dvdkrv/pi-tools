import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { reconcile, diffSignals } = await load('src/work/reconcile.ts');
const { emptyConfig } = await load('src/work/config.ts');

const config = { ...emptyConfig(), rules: [{ repo: 'payments-api', project: 'payments' }] };
const at = '2026-09-25T09:00:00.000Z';

function reviewObs(n, extra = {}) {
  return {
    key: `github:pr:example-org/payments-api#${n}`, kind: 'github-pr', url: `https://github.com/example-org/payments-api/pull/${n}`,
    title: `Review example-org/payments-api#${n}: change`, reason: 'Review requested', observedAt: at,
    state: { detailed: false, state: 'OPEN' }, meta: { repo: 'example-org/payments-api', org: 'example-org', jiraKeys: [] }, ...extra,
  };
}
const result = (observations, extra = {}) => ({ connector: 'github', query: 'review-requested:example-org', complete: true, status: 'ok', observations, ...extra });
const detailed = (state) => ({ detailed: true, state: 'OPEN', checks: 'passing', reviews: 0, comments: 0, reviewDecision: null, ...state });

async function setup() {
  const store = await memoryStore();
  store.upsertProject({ slug: 'payments', title: 'Payments' }, 'user');
  return store;
}

test('new observations become candidates once, with a project from the rules', async () => {
  const store = await setup();
  const summary = reconcile(store, result([reviewObs(1)]), config);
  assert.equal(summary.created, 1);
  reconcile(store, result([reviewObs(1)]), config);
  const [c] = store.listCandidates({ states: ['pending'] });
  assert.equal(store.listCandidates().length, 1);
  assert.equal(c.kind, 'new-item');
  assert.equal(c.proposedProject, 'payments');
  assert.equal(c.query, 'review-requested:example-org');
  assert.equal(c.payload.link.key, 'github:pr:example-org/payments-api#1');
});

test('dismissed keys never come back', async () => {
  const store = await setup();
  store.addDismissal('github:pr:example-org/payments-api#1', 'user');
  assert.equal(reconcile(store, result([reviewObs(1)]), config).created, 0);
});

test('only complete results withdraw vanished candidates from the same query', async () => {
  const store = await setup();
  reconcile(store, result([reviewObs(1)]), config);
  assert.equal(reconcile(store, result([], { complete: false }), config).withdrawn, 0);
  assert.equal(reconcile(store, result([], { query: 'authored:example-org' }), config).withdrawn, 0);
  assert.equal(reconcile(store, result([]), config).withdrawn, 1);
  assert.equal(store.listCandidates()[0].state, 'withdrawn');
});

test('linked PR changes record signals, and a merge proposes a Jira update once', async () => {
  const store = await setup();
  const item = store.addItem({ project: 'payments', title: 'Ship it', origin: 'manual' }, 'user');
  store.addLink(item.id, { kind: 'jira', key: 'jira:ABC-1', state: { status: 'In Progress', category: 'indeterminate', assignedToMe: true } }, 'user');
  store.addLink(item.id, { kind: 'github-pr', key: 'github:pr:example-org/payments-api#1', state: detailed({}) }, 'user');
  const merged = reviewObs(1, { reason: 'Linked PR', state: detailed({ state: 'MERGED', reviews: 1 }) });
  const summary = reconcile(store, result([merged], { query: 'linked-prs:example-org' }), config);
  assert.equal(summary.signals, 2);
  assert.deepEqual(store.listSignals().map((s) => s.kind).sort(), ['pr-merged', 'review-received']);
  const [update] = store.listCandidates({ states: ['pending'] });
  assert.equal(update.kind, 'jira-update');
  assert.equal(update.dedupeKey, 'jira-update:ABC-1:done');
  assert.equal(update.relatesTo, item.id);
  assert.deepEqual(update.payload, { ticket: 'ABC-1', targetCategory: 'done' });
  reconcile(store, result([merged], { query: 'linked-prs:example-org' }), config);
  assert.equal(store.listCandidates({ states: ['pending'] }).length, 1);
});

test('a less detailed observation never overwrites a detailed link state', async () => {
  const store = await setup();
  const item = store.addItem({ project: 'payments', title: 'x', origin: 'manual' }, 'user');
  store.addLink(item.id, { kind: 'github-pr', key: 'github:pr:example-org/payments-api#1', state: detailed({ reviews: 2 }) }, 'user');
  reconcile(store, result([reviewObs(1)]), config);
  assert.equal(store.findLinkByKey('github:pr:example-org/payments-api#1').state.reviews, 2);
});

test('observations mentioning a linked Jira key become attach-link candidates', async () => {
  const store = await setup();
  const item = store.addItem({ project: 'payments', title: 'x', origin: 'manual' }, 'user');
  store.addLink(item.id, { kind: 'jira', key: 'jira:ABC-9' }, 'user');
  reconcile(store, result([reviewObs(2, { meta: { repo: 'example-org/payments-api', jiraKeys: ['ABC-9'] } })]), config);
  const [c] = store.listCandidates();
  assert.equal(c.kind, 'attach-link');
  assert.equal(c.relatesTo, item.id);
});

test('an assigned ticket whose summary matches an item without Jira is proposed as an attachment', async () => {
  const store = await setup();
  const item = store.addItem({ project: 'payments', title: 'Promote me', origin: 'manual' }, 'user');
  const obs = {
    key: 'jira:ABC-5', kind: 'jira', url: 'https://example.atlassian.net/browse/ABC-5', title: 'ABC-5: Promote me', reason: 'Assigned to you in Jira', observedAt: at,
    state: { status: 'To Do', category: 'new', assignedToMe: true }, meta: { summary: 'Promote me', jiraProject: 'ABC' },
  };
  reconcile(store, { connector: 'jira', query: 'assigned-open', complete: true, status: 'ok', observations: [obs] }, config);
  const [c] = store.listCandidates();
  assert.equal(c.kind, 'attach-link');
  assert.equal(c.source, 'jira');
  assert.equal(c.relatesTo, item.id);
});

test('diffSignals covers Jira status and assignment changes', () => {
  assert.deepEqual(diffSignals('jira', { status: 'To Do', assignedToMe: true }, { status: 'Done', assignedToMe: false }), [
    { kind: 'jira-status-changed', detail: 'To Do → Done' },
    { kind: 'jira-unassigned', detail: 'no longer assigned to you' },
  ]);
  assert.deepEqual(diffSignals('jira', null, { status: 'Done' }), []);
  assert.deepEqual(diffSignals('github-pr', detailed({ checks: 'passing' }), detailed({ checks: 'failing', comments: 2 })).map((s) => s.kind), ['comments-new', 'checks-failing']);
});
