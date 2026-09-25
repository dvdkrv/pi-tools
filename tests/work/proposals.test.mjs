import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { proposeCandidate, MAX_PENDING_PER_SESSION } = await load('src/work/proposals.ts');
const { emptyConfig } = await load('src/work/config.ts');

const config = { ...emptyConfig(), rules: [{ repo: 'payments-api', project: 'payments' }] };
const proposer = { sessionId: 's1', repo: 'payments-api' };

async function setup() {
  const store = await memoryStore();
  store.upsertProject({ slug: 'payments', title: 'Payments' }, 'user');
  return store;
}

test('a proposal creates an agent candidate with the proposer and a project from the rules', async () => {
  const store = await setup();
  const r = proposeCandidate(store, { title: 'Fix flaky ingest test', reason: 'Failed twice', evidence: 'https://github.com/o/r/issues/1' }, proposer, config);
  assert.equal(r.status, 'created');
  assert.equal(r.candidate.source, 'agent');
  assert.equal(r.candidate.proposedProject, 'payments');
  assert.deepEqual(r.candidate.proposer, proposer);
  assert.equal(r.candidate.dedupeKey, 'agent:payments-api:fix-flaky-ingest-test');
  assert.equal(store.listEvents().at(-1).actor, 'agent:s1');
});

test('repeating a title updates the pending proposal instead of duplicating it', async () => {
  const store = await setup();
  proposeCandidate(store, { title: 'Fix flaky ingest test', reason: 'first' }, proposer, config);
  const r = proposeCandidate(store, { title: 'fix  FLAKY ingest test!', reason: 'second' }, proposer, config);
  assert.equal(r.status, 'updated');
  assert.equal(store.listCandidates().length, 1);
  assert.equal(store.listCandidates()[0].reason, 'second');
});

test('limits: five pending per session, validation, and dismissed keys', async () => {
  const store = await setup();
  for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
    assert.equal(proposeCandidate(store, { title: `Follow-up number ${i}`, reason: 'r' }, proposer, config).status, 'created');
  }
  const over = proposeCandidate(store, { title: 'One too many', reason: 'r' }, proposer, config);
  assert.equal(over.status, 'refused');
  assert.match(over.message, /final summary/);
  assert.equal(proposeCandidate(store, { title: 'One too many', reason: 'r' }, { sessionId: 's2', repo: 'payments-api' }, config).status, 'created');
  assert.equal(proposeCandidate(store, { title: 'ab', reason: 'r' }, proposer, config).status, 'refused');
  store.addDismissal('agent:none:ignored-idea', 'user');
  assert.match(proposeCandidate(store, { title: 'Ignored idea', reason: 'r' }, { sessionId: 's3', repo: null }, config).message, /dismissed/);
});

test('unknown projects fall back to the rules and unknown related items are ignored', async () => {
  const store = await setup();
  const r = proposeCandidate(store, { title: 'Something new', reason: 'r', project: 'nope', relatesTo: 'W-99' }, proposer, config);
  assert.equal(r.candidate.proposedProject, 'payments');
  assert.equal(r.candidate.relatesTo, null);
  assert.match(r.message, /ignored unknown item W-99/);
});
