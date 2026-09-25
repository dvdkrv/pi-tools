import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { parseCapture, resolveDue, linkFromUrl, captureItem, localDate } = await load('src/work/capture.ts');

const friday = new Date(2026, 8, 25, 12, 0, 0); // local Friday 2026-09-25

test('due dates: ISO, today, tomorrow, weekday on or after today', () => {
  assert.equal(resolveDue('2026-10-01', friday), '2026-10-01');
  assert.equal(resolveDue('today', friday), '2026-09-25');
  assert.equal(resolveDue('tomorrow', friday), '2026-09-26');
  assert.equal(resolveDue('fri', friday), '2026-09-25');
  assert.equal(resolveDue('Monday', friday), '2026-09-28');
  assert.throws(() => resolveDue('2026-02-30', friday), /Invalid due date/);
  assert.throws(() => resolveDue('someday', friday), /Invalid due date/);
});

test('link kinds and normalized keys', () => {
  assert.deepEqual(linkFromUrl('https://github.com/Example-Org/Repo/pull/42/files'), {
    kind: 'github-pr', key: 'github:pr:example-org/repo#42', url: 'https://github.com/Example-Org/Repo/pull/42',
  });
  assert.equal(linkFromUrl('https://github.com/o/r/issues/7').key, 'github:issue:o/r#7');
  assert.deepEqual(linkFromUrl('https://example.atlassian.net/browse/ABC-12'), {
    kind: 'jira', key: 'jira:ABC-12', url: 'https://example.atlassian.net/browse/ABC-12',
  });
  assert.equal(linkFromUrl('https://team.slack.com/archives/C1/p2').kind, 'chat');
  assert.equal(linkFromUrl('obsidian://open?vault=v&file=f').kind, 'note');
  assert.equal(linkFromUrl('https://example.com/x),').url, 'https://example.com/x');
});

test('parseCapture extracts project, due date, and links, and keeps #42 in the title', () => {
  const parsed = parseCapture('fix #42 flake #payments due:fri https://github.com/o/r/pull/1', friday);
  assert.equal(parsed.title, 'fix #42 flake');
  assert.equal(parsed.project, 'payments');
  assert.equal(parsed.due, '2026-09-25');
  assert.equal(parsed.links[0].kind, 'github-pr');
  assert.equal(parseCapture('https://example.com/only', friday).title, 'https://example.com/only');
  assert.throws(() => parseCapture('#a #b x', friday), /Only one/);
  assert.throws(() => parseCapture('   ', friday), /Nothing/);
});

test('captureItem creates an item directly with links, using rules without #project', async () => {
  const store = await memoryStore();
  store.upsertProject({ slug: 'payments', title: 'Payments' }, 'user');
  const ctx = { repo: 'payments-api', now: friday, knownProjects: new Set(['misc', 'payments']), rules: [{ repo: 'payments-api', project: 'payments' }] };
  const item = captureItem(store, 'reply to Lina https://team.slack.com/archives/C1/p2', ctx, 'user');
  assert.equal(item.project, 'payments');
  assert.equal(item.origin, 'manual');
  assert.equal(item.status, 'todo');
  assert.equal(store.listLinks(item.id)[0].kind, 'chat');
  assert.throws(() => captureItem(store, 'x #nope', ctx, 'user'), /Unknown project #nope/);
  assert.throws(() => captureItem(store, 'again https://team.slack.com/archives/C1/p2', ctx, 'user'), /already linked to W-1/);
  assert.equal(store.listItems().length, 1);
});

test('localDate formats local dates', () => {
  assert.equal(localDate(friday), '2026-09-25');
});
