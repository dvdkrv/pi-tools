import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const jira = await load('src/work/connectors/jira.ts');
const config = { site: 'https://example.atlassian.net', email: 'user@example.com', secretCommand: ['x'], defaultProject: 'ABC', defaultIssueType: 'Task' };

function client(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes.find((r) => url.endsWith(r.path) && (!r.method || r.method === init.method));
    return { status: route?.status ?? (route ? 200 : 404), text: async () => (route?.body === undefined ? '' : JSON.stringify(route.body)) };
  };
  return { client: new jira.JiraClient(config, { fetch, readSecret: async () => 'token-1234' }), calls };
}

async function setup() {
  const store = await memoryStore();
  store.upsertProject({ slug: 'payments', title: 'Payments', jiraEpic: 'ABC-100' }, 'user');
  const item = store.addItem({ project: 'payments', title: 'Rotate keys', notes: 'Line one\nLine two', origin: 'manual' }, 'user');
  store.addLink(item.id, { kind: 'github-pr', key: 'github:pr:o/r#1', url: 'https://github.com/o/r/pull/1' }, 'user');
  return { store, item };
}

test('promotion preview includes notes, links, and the project epic', async () => {
  const { store, item } = await setup();
  const preview = jira.promotionPreview(store, item.id, config);
  assert.equal(preview.summary, 'Rotate keys');
  assert.equal(preview.epic, 'ABC-100');
  assert.match(preview.description, /Line one\nLine two\n\nLinks:\n- https:\/\/github.com\/o\/r\/pull\/1/);
  assert.match(jira.formatPreview(preview), /Task in ABC under ABC-100/);
});

test('promote creates an assigned issue under the epic and links it; a second promote is refused', async () => {
  const { store, item } = await setup();
  const { client: c, calls } = client([
    { path: '/rest/api/3/myself', body: { accountId: 'me-1' } },
    { path: '/rest/api/3/issue', method: 'POST', body: { key: 'ABC-9' } },
  ]);
  const link = await jira.promoteItem(store, item.id, c);
  assert.equal(link.key, 'jira:ABC-9');
  assert.equal(link.url, 'https://example.atlassian.net/browse/ABC-9');
  const create = calls.find((call) => call.url.endsWith('/rest/api/3/issue')).body.fields;
  assert.deepEqual(create.project, { key: 'ABC' });
  assert.deepEqual(create.issuetype, { name: 'Task' });
  assert.deepEqual(create.assignee, { accountId: 'me-1' });
  assert.deepEqual(create.parent, { key: 'ABC-100' });
  assert.equal(create.description.type, 'doc');
  assert.throws(() => jira.promotionPreview(store, item.id, config), /already has a Jira ticket/);
});

test('transitions apply automatically only on a unique category match', async () => {
  const transitions = [
    { id: '1', name: 'Start', category: 'indeterminate' },
    { id: '2', name: 'Done', category: 'done' },
    { id: '3', name: "Won't do", category: 'done' },
  ];
  assert.equal(jira.chooseTransition(transitions.slice(0, 2), 'done').id, '2');
  assert.equal(jira.chooseTransition(transitions, 'done'), undefined);
});

test('applyJiraUpdate asks when ambiguous, can cancel, and marks the candidate accepted', async () => {
  const { store, item } = await setup();
  store.addLink(item.id, { kind: 'jira', key: 'jira:ABC-1', state: { status: 'In Progress', category: 'indeterminate', assignedToMe: true } }, 'user');
  const candidate = store.addCandidate({ kind: 'jira-update', source: 'github', dedupeKey: 'jira-update:ABC-1:done', title: 'Move ABC-1 to Done?', reason: 'merged', relatesTo: item.id, payload: { ticket: 'ABC-1', targetCategory: 'done' } }, 'sync:github');
  const transitions = { transitions: [{ id: '2', name: 'Done', to: { statusCategory: { key: 'done' } } }, { id: '3', name: "Won't do", to: { statusCategory: { key: 'done' } } }] };
  const { client: c, calls } = client([
    { path: '/rest/api/3/issue/ABC-1/transitions', method: 'GET', body: transitions },
    { path: '/rest/api/3/issue/ABC-1/transitions', method: 'POST', status: 204 },
  ]);
  assert.equal(await jira.applyJiraUpdate(store, candidate.id, c, async () => undefined), 'cancelled');
  assert.equal(store.getCandidate(candidate.id).state, 'pending');
  assert.equal(await jira.applyJiraUpdate(store, candidate.id, c, async (options) => options[0]), 'applied');
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.body), [{ transition: { id: '2' } }]);
  assert.equal(store.getCandidate(candidate.id).state, 'accepted');
  assert.equal(store.findLinkByKey('jira:ABC-1').state.category, 'done');
});
