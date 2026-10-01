import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { notifyNeedsMe } = await load('src/work/notify.ts');

function session(patch = {}) {
  return {
    cwd: '/src/api',
    tmuxPane: null,
    tmuxWindow: 'api',
    status: 'needs-me',
    note: 'Which tests should I run?',
    ...patch,
  };
}

function capture(options = {}) {
  const writes = [];
  const calls = [];
  notifyNeedsMe({
    session: session(),
    repo: null,
    env: {},
    tmux: (args) => { calls.push(args); return ''; },
    write: (value) => writes.push(value),
    ...options,
  });
  return { writes, calls };
}

test('writes an OSC 777 notification with the session display name and plain note', () => {
  const { writes } = capture();
  assert.deepEqual(writes, ['\x1b]777;notify;π api;Which tests should I run?\x07']);
});

test('wraps the notification for tmux passthrough and doubles its escape', () => {
  const { writes, calls } = capture({ env: { TMUX: 't', TMUX_PANE: '%3' } });
  assert.deepEqual(calls, [['list-clients', '-F', '#{pane_id}']]);
  assert.deepEqual(writes, ['\x1bPtmux;\x1b\x1b]777;notify;π api;Which tests should I run?\x07\x1b\\']);
});

test('sanitizes fields, flattens Markdown, and limits the body to 120 characters', () => {
  const note = `# **Choose** [this](https://example.test)\n${'x'.repeat(130)}\x07`;
  const { writes } = capture({
    session: session({ tmuxWindow: 'bad;\x1btitle', note }),
  });
  const sequence = writes[0];
  assert.ok(sequence.startsWith('\x1b]777;notify;π badtitle;Choose this '));
  assert.equal(sequence.includes('**'), false);
  assert.equal(sequence.includes('\n'), false);
  assert.equal(sequence.includes('\x1btitle'), false);
  const body = sequence.slice(sequence.lastIndexOf(';') + 1, -1);
  assert.equal([...body].length, 120);
  assert.ok(body.endsWith('…'));
});

test('skips a pane active in an attached tmux client', () => {
  const active = capture({
    env: { TMUX: 't', TMUX_PANE: '%3' },
    tmux: () => '%2\n%3\n',
  });
  assert.deepEqual(active.writes, []);

  const failed = capture({
    env: { TMUX: 't', TMUX_PANE: '%3' },
    tmux: () => { throw new Error('tmux is gone'); },
  });
  assert.equal(failed.writes.length, 1);
});

test('does not notify for another final status', () => {
  const { writes } = capture({ session: session({ status: 'done' }) });
  assert.deepEqual(writes, []);
});
