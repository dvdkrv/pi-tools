import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { parseWorkConfig, defaultConfigPath, defaultDataDir, expandHome, messagingConfig, DEFAULT_MESSAGING } = await load('src/work/config.ts');

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

test('dashboard triage defaults off and validates its boolean setting', () => {
  assert.equal(parseWorkConfig('{}').config.dashboard, undefined);
  assert.deepEqual(parseWorkConfig('{"dashboard":{"showTriage":true}}').config.dashboard, { showTriage: true });
  const badSection = parseWorkConfig('{"dashboard":[]}');
  assert.equal(badSection.config.dashboard, undefined);
  assert.deepEqual(badSection.warnings, ['dashboard must be an object; using the defaults']);
  const badValue = parseWorkConfig('{"dashboard":{"showTriage":"yes"}}');
  assert.deepEqual(badValue.config.dashboard, { showTriage: false });
  assert.deepEqual(badValue.warnings, ['dashboard.showTriage must be true or false; using false']);
});

test('messaging uses defaults when omitted and parses valid settings', () => {
  assert.deepEqual(messagingConfig(parseWorkConfig('{}').config), DEFAULT_MESSAGING);
  const { config, warnings } = parseWorkConfig(JSON.stringify({ messaging: {
    autoJoin: false,
    sendsPerHour: 24,
    paused: ['reviewer', 'session-prefix'],
    retentionDays: 14,
    routeCooldownMinutes: 2.5,
  } }));
  assert.deepEqual(warnings, []);
  assert.deepEqual(messagingConfig(config), {
    autoJoin: false,
    sendsPerHour: 24,
    paused: ['reviewer', 'session-prefix'],
    retentionDays: 14,
    routeCooldownMinutes: 2.5,
  });
});

test('invalid messaging section and values warn and use defaults', () => {
  const section = parseWorkConfig('{"messaging":[]}');
  assert.deepEqual(messagingConfig(section.config), DEFAULT_MESSAGING);
  assert.deepEqual(section.warnings, ['messaging must be an object; using the defaults']);

  const invalid = parseWorkConfig(JSON.stringify({ messaging: {
    autoJoin: 'yes',
    sendsPerHour: 0,
    paused: ['valid', 3],
    retentionDays: 1.5,
    routeCooldownMinutes: 0,
  } }));
  assert.deepEqual(messagingConfig(invalid.config), DEFAULT_MESSAGING);
  assert.deepEqual(invalid.warnings, [
    'messaging.autoJoin must be true or false; using true',
    'messaging.sendsPerHour must be a positive integer; using 10',
    'messaging.paused must be true, false, or a list of session names or id prefixes; using false',
    'messaging.retentionDays must be a positive integer; using 30',
    'messaging.routeCooldownMinutes must be a positive number; using 10',
  ]);

  const tooHigh = parseWorkConfig('{"messaging":{"sendsPerHour":1001}}');
  assert.equal(messagingConfig(tooHigh.config).sendsPerHour, 10);
  assert.deepEqual(tooHigh.warnings, ['messaging.sendsPerHour must be at most 1000; using 10']);
});

test('default paths follow XDG variables', () => {
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/x/config' }, '/h'), '/x/config/work/config.json');
  assert.equal(defaultConfigPath({}, '/h'), '/h/.config/work/config.json');
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/x/data' }, '/h'), '/x/data/work');
  assert.equal(defaultDataDir({}, '/h'), '/h/.local/share/work');
  assert.equal(expandHome('~/notes', '/h'), '/h/notes');
  assert.equal(expandHome('~', '/h'), '/h');
});

test('notifications default on and parse only booleans', () => {
  assert.equal(parseWorkConfig('{}').config.notifications, undefined);
  assert.equal(parseWorkConfig('{"notifications": false}').config.notifications, false);
  assert.equal(parseWorkConfig('{"notifications": true}').config.notifications, true);
  const bad = parseWorkConfig('{"notifications": "no"}');
  assert.equal(bad.config.notifications, undefined);
  assert.deepEqual(bad.warnings, ['notifications must be true or false; notifications stay on']);
});

test('bashTimeoutMinutes defaults to 30 and must be a positive number', async () => {
  const { parseWorkConfig, bashTimeoutMinutes } = await load('src/work/config.ts');
  assert.equal(bashTimeoutMinutes(parseWorkConfig('{}').config), 30);
  assert.equal(bashTimeoutMinutes(parseWorkConfig('{"bashTimeoutMinutes": 45}').config), 45);
  const bad = parseWorkConfig('{"bashTimeoutMinutes": -3}');
  assert.equal(bashTimeoutMinutes(bad.config), 30);
  assert.deepEqual(bad.warnings, ['bashTimeoutMinutes must be a positive number; using 30']);
});
