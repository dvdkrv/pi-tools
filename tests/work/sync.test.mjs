import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';
import { join } from 'node:path';

const { syncAll, formatSyncReport } = await load('src/work/sync.ts');
const { JiraClient } = await load('src/work/connectors/jira.ts');
const { emptyConfig } = await load('src/work/config.ts');

const jiraConfig = { site: 'https://example.atlassian.net', email: 'user@example.com', secretCommand: ['x'], defaultProject: 'ABC', defaultIssueType: 'Task' };

function jiraClient(state) {
  const fetch = async (url, init) => {
    state.calls++;
    if (state.fail) return { status: 401, text: async () => 'no' };
    if (url.endsWith('/myself')) return { status: 200, text: async () => JSON.stringify({ accountId: 'me' }) };
    const body = JSON.parse(init.body);
    const issues = body.jql.startsWith('assignee') ? state.assigned : [];
    return { status: 200, text: async () => JSON.stringify({ issues, isLast: true }) };
  };
  return new JiraClient(jiraConfig, { fetch, readSecret: async () => 'token-1234' });
}

const issue = (key) => ({ key, fields: { summary: key, status: { name: 'To Do', statusCategory: { key: 'new' } }, assignee: { accountId: 'me' }, project: { key: 'ABC' } } });

test('sync reconciles, caches for 10 minutes, and backs up at most hourly', async () => {
  const now = clock();
  const store = await memoryStore(now);
  const state = { calls: 0, assigned: [issue('ABC-1')] };
  const backupDir = join(tempDir(), 'backups');
  const config = { ...emptyConfig(), jira: jiraConfig };
  const deps = { jira: jiraClient(state), backupDir };

  const first = await syncAll(store, config, deps);
  assert.deepEqual(first.ran, ['jira']);
  assert.deepEqual(first.disabled, ['github']);
  assert.equal(first.totals.created, 1);
  assert.equal(readdirSync(backupDir).length, 1);

  now.advance(5 * 60_000);
  const second = await syncAll(store, config, deps);
  assert.deepEqual(second.cached, ['jira']);
  assert.equal(state.calls, 2);

  const forced = await syncAll(store, config, deps, { force: true });
  assert.deepEqual(forced.ran, ['jira']);
  assert.equal(state.calls, 3); // account ID is cached; only the search runs again
  assert.equal(readdirSync(backupDir).length, 1);
  assert.match(formatSyncReport(forced), /synced: jira/);
});

test('failed connectors record status, are not cached, and never change items', async () => {
  const now = clock();
  const store = await memoryStore(now);
  const state = { calls: 0, assigned: [], fail: true };
  const config = { ...emptyConfig(), jira: jiraConfig };
  const report = await syncAll(store, config, { jira: jiraClient(state) });
  assert.match(report.warnings.join('\n'), /jira assigned-open: auth-failed; data as of never/);
  assert.equal(store.listCandidates().length, 0);
  const again = await syncAll(store, config, { jira: jiraClient(state) });
  assert.deepEqual(again.ran, ['jira']);
});
