import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const tmux = await load('src/work/tmux.ts');

function fake(responses = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const response = responses[args[0]];
    if (response instanceof Error) throw response;
    return response ?? '';
  };
  return { run, calls };
}

test('parsePanes reads the tab-separated pane listing', () => {
  assert.deepEqual(tmux.parsePanes('%1\t@1\tapi\tmain\t/src/api\tzsh\n\n%2\t@2\tweb\tmain\t/src/web\tnode\n'), [
    { paneId: '%1', windowId: '@1', windowName: 'api', sessionName: 'main', path: '/src/api', command: 'zsh' },
    { paneId: '%2', windowId: '@2', windowName: 'web', sessionName: 'main', path: '/src/web', command: 'node' },
  ]);
});

test('listPanes and windowNameOf return nothing when tmux fails', () => {
  const broken = fake({ 'list-panes': new Error('no server running'), 'display-message': new Error('no server running') });
  assert.equal(tmux.listPanes(broken.run), undefined);
  assert.equal(tmux.windowNameOf(broken.run, '%1'), null);
  const working = fake({ 'display-message': 'editor\n' });
  assert.equal(tmux.windowNameOf(working.run, '%1'), 'editor');
  assert.deepEqual(working.calls[0], ['display-message', '-p', '-t', '%1', '#{window_name}']);
});

test('isShell accepts common and login shells only', () => {
  for (const shell of ['zsh', '-zsh', 'bash', 'fish', 'sh']) assert.equal(tmux.isShell(shell), true, shell);
  for (const other of ['node', 'vim', 'pi', '']) assert.equal(tmux.isShell(other), false, other);
});

test('jumpToPane selects the window and pane and tolerates a missing client', () => {
  const noClient = fake({ 'switch-client': new Error('no current client') });
  assert.deepEqual(tmux.jumpToPane(noClient.run, '%4', true), { kind: 'jumped' });
  assert.deepEqual(noClient.calls, [['switch-client', '-t', '%4'], ['select-window', '-t', '%4'], ['select-pane', '-t', '%4']]);
});

test('jumpToPane prints an attach command outside tmux', () => {
  const none = fake();
  assert.deepEqual(tmux.jumpToPane(none.run, '%4', false), { kind: 'print', command: "tmux attach-session -t '%4' \\; select-window -t '%4' \\; select-pane -t '%4'" });
  assert.deepEqual(none.calls, []);
});

test('popupArgs opens a 90% popup that closes with the command', () => {
  assert.deepEqual(tmux.popupArgs("'node' 'work.ts' dash"), ['display-popup', '-E', '-w', '90%', '-h', '90%', "'node' 'work.ts' dash"]);
});
