import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, load, memoryRuntime } from './helpers.mjs';

const { buildDashModel } = await load('src/work/dash/model.ts');
const { rowCells, rowMatches, hintsFor } = await load('src/work/dash/view.ts');
const { runDash } = await load('src/work/dash/app.ts');
const { plainStyle } = await load('src/work/dash/text.ts');

const NOW = new Date(2026, 8, 25, 9, 0, 0);
const message = (overrides = {}) => ({
  id: 'm1', at: new Date(2026, 8, 25, 8, 45, 0).toISOString(), groupLabel: 'host',
  senderPeer: 'p1', senderSession: 's1', senderName: 'Alice', recipientPeer: 'p2', recipientSession: 's2', recipientName: 'Bob',
  kind: 'notice', inReplyTo: null, state: 'observed', stateAt: new Date(2026, 8, 25, 8, 46, 0).toISOString(), body: 'hello',
  ...overrides,
});

function fakeTerminal(columns = 100) {
  let input = () => {};
  const terminal = {
    writes: [],
    columns: () => columns,
    rows: () => 30,
    write(data) { terminal.writes.push(data); },
    onInput(handler) { input = handler; },
    onResize() {},
    start() {},
    stop() {},
    send(...keys) { for (const key of keys) input(key); },
    screen() {
      return terminal.writes.at(-1).replace(/^\x1b\[H/, '').replace(/\x1b\[J$/, '').split('\x1b[K\r\n').map((line) => line.replace(/\x1b\[K$/, '').trimEnd());
    },
  };
  return terminal;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function open(runtime, columns = 100) {
  const terminal = fakeTerminal(columns);
  const result = runDash({
    runtime, terminal, tmux: (args) => args[0] === 'list-panes' ? '' : '', insideTmux: true,
    style: plainStyle, refreshMs: 0, host: null,
  });
  return { terminal, result };
}

function record(store, entry) {
  store.logMessage(entry);
}

test('messages form a section after Jobs and preserve newest-first input order', () => {
  const newest = message({ id: 'new', at: new Date(2026, 8, 25, 8, 55).toISOString() });
  const older = message({ id: 'old', at: new Date(2026, 8, 25, 8, 30).toISOString() });
  const model = buildDashModel({ sessions: [], triageCount: 0, messages: [newest, older], now: NOW });

  assert.deepEqual(model.sections.map((section) => section.id), ['decisions', 'waiting', 'working', 'jobs', 'messages', 'other']);
  assert.deepEqual(model.sections[4].rows.map((row) => [row.kind, row.key, row.message.id]), [
    ['message', 'message:new', 'new'],
    ['message', 'message:old', 'old'],
  ]);
});

test('message cells show kind, peers, local time, age, and the first non-empty sanitized body line', () => {
  const row = { kind: 'message', key: 'message:m1', message: message({ body: '\n\x00\n  Hello\x00 world\nsecond line' }) };

  assert.deepEqual(rowCells(row, NOW, true), {
    label: 'notice', window: 'Alice → Bob', item: '08:45', age: '15m', note: 'Hello world',
  });
  assert.equal(hintsFor(row), 'enter message · j/k move · / filter · ? all keys · q quit');
});

test('message filtering searches names, kind, and the full body', () => {
  const row = { kind: 'message', key: 'message:m1', message: message({ kind: 'request', recipientName: 'Release Captain', body: 'first line\nhidden needle' }) };

  assert.equal(rowMatches(row, 'alice', NOW), true);
  assert.equal(rowMatches(row, 'captain', NOW), true);
  assert.equal(rowMatches(row, 'request', NOW), true);
  assert.equal(rowMatches(row, 'hidden needle', NOW), true);
  assert.equal(rowMatches(row, 'missing', NOW), false);
});

test('Enter on a reply shows its full body and the request it answers', async () => {
  const runtime = await memoryRuntime({ now: clock('2026-09-25T09:00:00.000Z') });
  record(runtime.store, message({ id: 'req', at: '2026-09-25T08:00:00.000Z', kind: 'request', state: 'observed', body: 'Please inspect\nall failures' }));
  record(runtime.store, message({ id: 'rep', at: '2026-09-25T08:30:00.000Z', senderName: 'Bob', recipientName: 'Alice', kind: 'reply', inReplyTo: 'req', state: 'attempted', body: 'I found\nthe cause' }));
  const dash = open(runtime);

  dash.terminal.send('\r');
  await tick();
  const screen = dash.terminal.screen();
  assert.equal(screen[0], 'Message (read-only)');
  assert.ok(screen.some((line) => line.includes('Bob → Alice  reply  delivering')), screen.join('\n'));
  assert.ok(screen.includes('I found'));
  assert.ok(screen.includes('the cause'));
  assert.ok(screen.includes('--- request ---'));
  assert.ok(screen.some((line) => line.includes('Alice → Bob  request  delivered')), screen.join('\n'));
  assert.ok(screen.includes('Please inspect'));
  assert.ok(screen.includes('all failures'));
  dash.terminal.send('q');
  await tick();
  dash.terminal.send('q');
  await dash.result;
});

test('message details wrap long body lines at the display width', async () => {
  const runtime = await memoryRuntime({ now: clock('2026-09-25T09:00:00.000Z') });
  record(runtime.store, message({ body: 'This message body is deliberately longer than the narrow dashboard width so its ending remains visible.' }));
  const dash = open(runtime, 40);

  dash.terminal.send('\r');
  await tick();
  const screen = dash.terminal.screen();
  assert.ok(screen.includes('ending remains visible.'), screen.join('\n'));
  assert.ok(screen.every((line) => line.length <= 40), screen.join('\n'));
  dash.terminal.send('q');
  await tick();
  dash.terminal.send('q');
  await dash.result;
});

test('Enter on a request shows each reply', async () => {
  const runtime = await memoryRuntime({ now: clock('2026-09-25T09:00:00.000Z') });
  record(runtime.store, message({ id: 'req', at: '2026-09-25T08:00:00.000Z', kind: 'request', body: 'Status?' }));
  record(runtime.store, message({ id: 'rep-1', at: '2026-09-25T08:10:00.000Z', kind: 'reply', inReplyTo: 'req', body: 'First reply' }));
  record(runtime.store, message({ id: 'rep-2', at: '2026-09-25T08:20:00.000Z', kind: 'reply', inReplyTo: 'req', body: 'Second reply' }));
  const dash = open(runtime);

  dash.terminal.send('G', '\r');
  await tick();
  const screen = dash.terminal.screen();
  assert.equal(screen.filter((line) => line === '--- reply ---').length, 2, screen.join('\n'));
  assert.ok(screen.includes('First reply'));
  assert.ok(screen.includes('Second reply'));
  dash.terminal.send('q');
  await tick();
  dash.terminal.send('q');
  await dash.result;
});
