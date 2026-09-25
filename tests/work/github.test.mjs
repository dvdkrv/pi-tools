import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { fetchGithub, checksSummary, parsePrKey, prKey, classifyGhError } = await load('src/work/connectors/github.ts');

const accounts = [{ user: 'work-account', orgs: ['example-org'] }];
const view = (number, extra = {}) => ({
  url: `https://github.com/example-org/api/pull/${number}`, title: `ABC-7 change ${number}`, number, state: 'OPEN', headRefName: 'feature',
  reviewDecision: '', reviews: [{}], comments: [], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra,
});

function fakeGh(handlers) {
  const calls = [];
  const run = async (args, env = {}) => {
    calls.push({ args, env });
    const key = args.join(' ');
    for (const [pattern, reply] of handlers) {
      if (key.includes(pattern)) {
        if (reply instanceof Error) throw reply;
        return typeof reply === 'string' ? reply : JSON.stringify(reply);
      }
    }
    throw new Error(`unexpected gh call: ${key}`);
  };
  return { run, calls };
}

test('review requests are shallow, and authored and linked PRs are detailed', async () => {
  const { run, calls } = fakeGh([
    ['auth token --user work-account', 'gho_TOKEN\n'],
    ['--review-requested=@me', [{ url: 'https://github.com/example-org/api/pull/1', title: 'Add thing', number: 1, repository: { nameWithOwner: 'example-org/api' } }]],
    ['--author=@me', [{ url: 'https://github.com/example-org/api/pull/2', title: 'Mine', number: 2, repository: { nameWithOwner: 'example-org/api' } }]],
    ['pr view 2 --repo example-org/api', view(2)],
    ['pr view 3 --repo example-org/api', view(3, { state: 'MERGED' })],
  ]);
  const results = await fetchGithub(accounts, run, [prKey('example-org/api', 2), prKey('example-org/api', 3), 'github:pr:other-org/x#9'], new Date('2026-09-25T09:00:00Z'));
  assert.deepEqual(results.map((r) => [r.query, r.status, r.complete]), [
    ['review-requested:example-org', 'ok', true],
    ['authored:example-org', 'ok', true],
    ['linked-prs:example-org', 'ok', true],
  ]);
  const [review, authored, linked] = results;
  assert.equal(review.observations[0].key, 'github:pr:example-org/api#1');
  assert.equal(review.observations[0].title, 'Review example-org/api#1: Add thing');
  assert.deepEqual(review.observations[0].state, { detailed: false, state: 'OPEN' });
  assert.deepEqual(authored.observations[0].state, { detailed: true, state: 'OPEN', checks: 'passing', reviews: 1, comments: 0, reviewDecision: null });
  assert.deepEqual(authored.observations[0].meta.jiraKeys, ['ABC-7']);
  assert.deepEqual(linked.observations.map((o) => o.key), ['github:pr:example-org/api#3']);
  assert.ok(calls.slice(1).every((c) => c.env.GH_TOKEN === 'gho_TOKEN'));
  assert.equal(calls.filter((c) => c.args.join(' ').includes('pr view 2')).length, 1);
});

test('token failures mark every query of that account as failed', async () => {
  const { run } = fakeGh([['auth token', new Error('no oauth token found for work-account')]]);
  const results = await fetchGithub(accounts, run, [], new Date());
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'auth-failed' && r.complete === false));
});

test('search results at the limit are incomplete, and failures are isolated per query', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ url: `u${i}`, title: 't', number: i + 1, repository: { nameWithOwner: 'example-org/api' } }));
  const { run } = fakeGh([
    ['auth token', 'gho_TOKEN'],
    ['--review-requested=@me', many],
    ['--author=@me', new Error('HTTP 502: could not resolve host')],
  ]);
  const [review, authored] = await fetchGithub(accounts, run, [], new Date());
  assert.equal(review.complete, false);
  assert.equal(authored.status, 'unreachable');
});

test('helpers: checks summary, PR keys, error classification', () => {
  assert.equal(checksSummary([]), 'none');
  assert.equal(checksSummary([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(checksSummary([{ status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(checksSummary([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failing');
  assert.deepEqual(parsePrKey('github:pr:example-org/api#12'), { repo: 'example-org/api', number: 12 });
  assert.equal(parsePrKey('jira:ABC-1'), undefined);
  assert.equal(prKey('Example-Org/API', 3), 'github:pr:example-org/api#3');
  assert.equal(classifyGhError('HTTP 401: Bad credentials'), 'auth-failed');
  assert.equal(classifyGhError('dial tcp: connection refused'), 'unreachable');
  assert.equal(classifyGhError('something else'), 'error');
});
