import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { JiraClient, fetchJira } = await load('src/work/connectors/jira.ts');
const { redact } = await load('src/work/secrets.ts');

const config = { site: 'https://example.atlassian.net', email: 'user@example.com', secretCommand: ['pass', 'show', 'jira'], defaultProject: 'ABC', defaultIssueType: 'Task' };
const TOKEN = 'tok-SECRET-1234';

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes.find((r) => url.endsWith(r.path) && (!r.match || r.match(JSON.parse(init.body ?? 'null'))));
    if (!handler) return { status: 404, text: async () => 'not found' };
    const out = typeof handler.reply === 'function' ? handler.reply(calls.at(-1)) : handler.reply;
    if (out instanceof Error) throw out;
    return { status: out.status ?? 200, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)) };
  };
  return { fetch, calls };
}

const issue = (key, extra = {}) => ({
  key,
  fields: { summary: `Summary ${key}`, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, assignee: { accountId: 'me-1' }, parent: { key: 'ABC-100' }, project: { key: 'ABC' }, ...extra },
});

const myself = { path: '/rest/api/3/myself', reply: { body: { accountId: 'me-1' } } };

test('assigned-open paginates and maps issues to observations', async () => {
  const { fetch, calls } = fakeFetch([
    myself,
    { path: '/rest/api/3/search/jql', match: (b) => b.jql.startsWith('assignee') && !b.nextPageToken, reply: { body: { issues: [issue('ABC-1')], nextPageToken: 'p2' } } },
    { path: '/rest/api/3/search/jql', match: (b) => b.jql.startsWith('assignee') && b.nextPageToken === 'p2', reply: { body: { issues: [issue('ABC-2')], isLast: true } } },
  ]);
  const client = new JiraClient(config, { fetch, readSecret: async () => TOKEN });
  const [assigned, linked] = await fetchJira(client, [], new Date('2026-09-25T09:00:00Z'));
  assert.equal(assigned.query, 'assigned-open');
  assert.equal(assigned.complete, true);
  assert.deepEqual(assigned.observations.map((o) => o.key), ['jira:ABC-1', 'jira:ABC-2']);
  const [first] = assigned.observations;
  assert.equal(first.url, 'https://example.atlassian.net/browse/ABC-1');
  assert.equal(first.title, 'ABC-1: Summary ABC-1');
  assert.deepEqual(first.state, { status: 'In Progress', category: 'indeterminate', assignedToMe: true });
  assert.deepEqual(first.meta, { summary: 'Summary ABC-1', jiraEpic: 'ABC-100', jiraProject: 'ABC' });
  assert.equal(linked.query, 'linked-state');
  assert.equal(linked.observations.length, 0);
  const auth = calls[0].init.headers.Authorization;
  assert.equal(auth, `Basic ${Buffer.from(`user@example.com:${TOKEN}`).toString('base64')}`);
});

test('linked-state batches keys, ignores invalid keys, and falls back per key on error', async () => {
  const { fetch, calls } = fakeFetch([
    myself,
    { path: '/rest/api/3/search/jql', match: (b) => b.jql.startsWith('assignee'), reply: { body: { issues: [], isLast: true } } },
    { path: '/rest/api/3/search/jql', match: (b) => b.jql === 'key in (ABC-1,ABC-2)', reply: { status: 400, body: 'An issue with key ABC-2 does not exist' } },
    { path: '/rest/api/3/search/jql', match: (b) => b.jql === 'key in (ABC-1)', reply: { body: { issues: [issue('ABC-1')], isLast: true } } },
    { path: '/rest/api/3/search/jql', match: (b) => b.jql === 'key in (ABC-2)', reply: { status: 400, body: 'missing' } },
  ]);
  const client = new JiraClient(config, { fetch, readSecret: async () => TOKEN });
  const [, linked] = await fetchJira(client, ['ABC-1', 'ABC-2', 'bad key) OR 1=1'], new Date());
  assert.equal(linked.status, 'ok');
  assert.equal(linked.complete, false);
  assert.deepEqual(linked.observations.map((o) => o.key), ['jira:ABC-1']);
  assert.ok(calls.every((c) => !JSON.stringify(c.body ?? {}).includes('1=1')));
});

test('401 is auth-failed, network errors are unreachable, and secrets are redacted', async () => {
  const unauthorized = new JiraClient(config, { fetch: fakeFetch([{ path: '/rest/api/3/myself', reply: { status: 401, body: 'no' } }]).fetch, readSecret: async () => TOKEN });
  const [a] = await fetchJira(unauthorized, [], new Date());
  assert.equal(a.status, 'auth-failed');

  const offline = new JiraClient(config, { fetch: fakeFetch([{ path: '/rest/api/3/myself', reply: new Error(`connect ECONNREFUSED with ${TOKEN}`) }]).fetch, readSecret: async () => TOKEN });
  const [b] = await fetchJira(offline, [], new Date());
  assert.equal(b.status, 'unreachable');
  assert.doesNotMatch(b.error, /SECRET/);

  const echo = new JiraClient(config, { fetch: fakeFetch([myself, { path: '/rest/api/3/search/jql', reply: { status: 500, body: `boom ${TOKEN}` } }]).fetch, readSecret: async () => TOKEN });
  const [c] = await fetchJira(echo, [], new Date());
  assert.equal(c.status, 'error');
  assert.match(c.error, /\[redacted\]/);
  assert.doesNotMatch(c.error, /SECRET/);

  const noSecret = new JiraClient(config, { fetch: fakeFetch([]).fetch, readSecret: async () => { throw new Error('pass failed'); } });
  const [d] = await fetchJira(noSecret, [], new Date());
  assert.equal(d.status, 'auth-failed');
});

test('redact replaces every occurrence of each secret', () => {
  assert.equal(redact('a SECRETX b SECRETX', ['SECRETX', '']), 'a [redacted] b [redacted]');
});
