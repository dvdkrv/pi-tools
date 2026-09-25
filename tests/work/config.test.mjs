import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { parseWorkConfig, defaultConfigPath, defaultDataDir, expandHome } = await load('src/work/config.ts');

const valid = {
  jira: { site: 'https://example.atlassian.net/', email: 'user@example.com', secret: { command: ['pass', 'show', 'jira'] }, defaultProject: 'ABC' },
  github: { accounts: [{ user: 'work-account', orgs: ['example-org'] }] },
  projects: [{ slug: 'payments', title: 'Payments', jiraEpic: 'ABC-100' }],
  rules: [{ repo: 'payments-api', project: 'payments' }, { jiraEpic: 'ABC-100', project: 'payments' }],
  planner: { cwd: '~' },
};

test('valid config parses without warnings', () => {
  const { config, warnings } = parseWorkConfig(JSON.stringify(valid));
  assert.deepEqual(warnings, []);
  assert.equal(config.jira.site, 'https://example.atlassian.net');
  assert.equal(config.jira.defaultIssueType, 'Task');
  assert.deepEqual(config.jira.secretCommand, ['pass', 'show', 'jira']);
  assert.equal(config.github.accounts[0].user, 'work-account');
  assert.equal(config.projects[0].slug, 'payments');
  assert.equal(config.rules.length, 2);
  assert.equal(config.plannerCwd, '~');
});

test('invalid JSON disables connectors with a warning', () => {
  const { config, warnings } = parseWorkConfig('{');
  assert.equal(config.jira, undefined);
  assert.deepEqual(config.github.accounts, []);
  assert.match(warnings[0], /not valid JSON/);
});

test('invalid sections are dropped individually', () => {
  const { config, warnings } = parseWorkConfig(JSON.stringify({
    jira: { site: 'http://insecure', email: 'x', secret: { command: [] }, defaultProject: 'ABC' },
    github: { accounts: [{ user: 'a' }] },
    projects: [{ slug: 'Bad Slug', title: 'x' }],
    rules: [{ repo: 'r', jiraEpic: 'E-1', project: 'misc' }],
  }));
  assert.equal(config.jira, undefined);
  assert.equal(config.github.accounts.length, 0);
  assert.equal(config.projects.length, 0);
  assert.equal(config.rules.length, 0);
  assert.equal(warnings.length, 4);
});

test('default paths follow XDG variables', () => {
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/x/config' }, '/h'), '/x/config/work/config.json');
  assert.equal(defaultConfigPath({}, '/h'), '/h/.config/work/config.json');
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/x/data' }, '/h'), '/x/data/work');
  assert.equal(defaultDataDir({}, '/h'), '/h/.local/share/work');
  assert.equal(expandHome('~/notes', '/h'), '/h/notes');
  assert.equal(expandHome('~', '/h'), '/h');
});
