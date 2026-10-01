import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { MIGRATIONS } = await load('src/work/migrations.ts');
const { WorkStore } = await load('src/work/store.ts');
const { formatMessageLog, messageStateLabel, parseSince } = await load('src/work/messages.ts');

const entry = (id, at, overrides = {}) => ({
  id,
  at,
  groupLabel: 'host',
  senderPeer: `peer-${id}-from`,
  senderSession: `session-${id}-from`,
  senderName: 'Alice',
  recipientPeer: `peer-${id}-to`,
  recipientSession: `session-${id}-to`,
  recipientName: 'Bob',
  kind: 'request',
  inReplyTo: null,
  state: 'queued',
  body: `body ${id}`,
  ...overrides,
});

test('migration 4 upgrades an existing schema 3 database and keeps mode 0600', () => {
  const path = join(tempDir(), 'work.db');
  const raw = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 3)) raw.exec(migration);
  raw.exec('PRAGMA user_version = 3');
  raw.close();
  chmodSync(path, 0o600);

  const store = WorkStore.open(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'message_log'").get().n, 1);
  store.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('message log inserts once, updates changed states, and lists open ids', async () => {
  const store = await memoryStore();
  store.logMessage(entry('m1', '2026-09-25T08:00:00.000Z'));
  store.logMessage(entry('m1', '2026-09-25T08:00:00.000Z', { body: 'retry must be ignored', state: 'observed' }));
  store.logMessage(entry('m2', '2026-09-25T08:01:00.000Z', { state: 'observed', stateAt: '2026-09-25T08:02:00.000Z' }));

  assert.equal(store.listMessageLog().find((message) => message.id === 'm1').body, 'body m1');
  assert.equal(store.listMessageLog().find((message) => message.id === 'm1').stateAt, '2026-09-25T08:00:00.000Z');
  assert.equal(store.setMessageStates([
    { id: 'm1', state: 'attempted', at: '2026-09-25T08:03:00.000Z' },
    { id: 'm2', state: 'observed', at: '2026-09-25T08:03:00.000Z' },
    { id: 'missing', state: 'queued', at: '2026-09-25T08:03:00.000Z' },
  ]), 1);
  assert.deepEqual(store.openMessageIds(), ['m1']);
  assert.equal(store.listMessageLog().find((message) => message.id === 'm1').stateAt, '2026-09-25T08:03:00.000Z');
});

test('message log filters newest first by inclusive time, names, session prefix, and limit', async () => {
  const store = await memoryStore();
  store.logMessage(entry('m1', '2026-09-25T08:00:00.000Z', { senderName: 'Alpha One' }));
  store.logMessage(entry('m2', '2026-09-25T09:00:00.000Z', { recipientName: 'Beta Two' }));
  store.logMessage(entry('m3', '2026-09-25T10:00:00.000Z', { senderSession: 'Prefix-123' }));

  assert.deepEqual(store.listMessageLog().map((message) => message.id), ['m3', 'm2', 'm1']);
  assert.deepEqual(store.listMessageLog({ since: '2026-09-25T09:00:00.000Z' }).map((message) => message.id), ['m3', 'm2']);
  assert.deepEqual(store.listMessageLog({ peer: 'BETA' }).map((message) => message.id), ['m2']);
  assert.deepEqual(store.listMessageLog({ peer: 'prefix-' }).map((message) => message.id), ['m3']);
  assert.deepEqual(store.listMessageLog({ limit: 1 }).map((message) => message.id), ['m3']);
});

test('message threads connect requests and replies, and pruning removes only older rows', async () => {
  const store = await memoryStore();
  store.logMessage(entry('request-1', '2026-09-24T08:00:00.000Z'));
  store.logMessage(entry('reply-1', '2026-09-25T08:00:00.000Z', { kind: 'reply', inReplyTo: 'request-1' }));
  store.logMessage(entry('reply-2', '2026-09-25T09:00:00.000Z', { kind: 'reply', inReplyTo: 'request-1' }));

  const reply = store.messageThread('reply-1');
  assert.equal(reply.message.id, 'reply-1');
  assert.equal(reply.request.id, 'request-1');
  assert.deepEqual(reply.replies, []);
  assert.deepEqual(store.messageThread('request-1').replies.map((message) => message.id), ['reply-1', 'reply-2']);
  assert.equal(store.messageThread('missing'), undefined);
  assert.equal(store.pruneMessageLog('2026-09-25T08:00:00.000Z'), 1);
  assert.deepEqual(store.listMessageLog().map((message) => message.id), ['reply-2', 'reply-1']);
});

test('message formatting is oldest first, labels states, indents bodies, and escapes controls', () => {
  const entries = [
    { ...entry('reply-123456789', '2026-09-25T09:02:00.000Z', { senderName: 'Bob', recipientName: 'Alice', kind: 'reply', inReplyTo: 'request-abcdef', state: 'observed', body: 'second\nline\u0001' }), stateAt: '2026-09-25T09:02:00.000Z' },
    { ...entry('request-abcdef', '2026-09-25T09:01:00.000Z', { state: 'attempted', body: 'first\tline' }), stateAt: '2026-09-25T09:01:00.000Z' },
  ];
  assert.equal(formatMessageLog(entries, new Date('2026-09-25T10:00:00.000Z')), [
    '2026-09-25 09:01  Alice -> Bob  request  delivering',
    '    first\tline',
    '',
    '2026-09-25 09:02  Bob -> Alice  reply  delivered  re request-',
    '    second',
    '    line\\x01',
  ].join('\n'));
  assert.equal(messageStateLabel('terminal-unresolved'), 'unconfirmed');
  assert.equal(messageStateLabel('expired'), 'expired');
});

test('parseSince accepts minute, hour, day, and plain-hour ages and rejects invalid input', () => {
  assert.equal(parseSince('30m'), 30 * 60_000);
  assert.equal(parseSince('2h'), 2 * 3_600_000);
  assert.equal(parseSince('7d'), 7 * 86_400_000);
  assert.equal(parseSince('3'), 3 * 3_600_000);
  for (const value of ['', '0', '2w', '-1h', 'half']) assert.throws(() => parseSince(value), /age like 30m, 2h, or 7d/);
});
