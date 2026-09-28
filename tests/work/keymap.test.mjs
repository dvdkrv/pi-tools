import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { DASHBOARD, DASHBOARD_OPTIONS, NAVIGATION } from './fixtures/keymap-table.mjs';

const keymap = await load('src/work/keymap.ts');

function run(keys, options) {
  let state = keymap.INITIAL_KEY_STATE;
  let action;
  for (const data of keys) ({ state, action } = keymap.keyStep(state, keymap.decodeKey(data), options));
  return action;
}

for (const entry of [...NAVIGATION, ...DASHBOARD]) {
  test(`keymap: ${entry.name}`, () => {
    assert.deepEqual(run(entry.keys, DASHBOARD_OPTIONS), entry.action);
  });
}

test('decodeKey names legacy sequences and splitKeys separates a burst of input', () => {
  assert.equal(keymap.decodeKey('\x1b[Z'), 'shift+tab');
  assert.equal(keymap.decodeKey('\x04'), 'ctrl+d');
  assert.equal(keymap.decodeKey('\x7f'), 'backspace');
  assert.equal(keymap.decodeKey('\r'), 'enter');
  assert.equal(keymap.decodeKey('é'), 'é');
  assert.equal(keymap.decodeKey('\x1b[99~'), undefined);
  assert.deepEqual(keymap.splitKeys('jj\x1b[Bk\x1bOA\x1b'), ['j', 'j', '\x1b[B', 'k', '\x1bOA', '\x1b']);
  assert.deepEqual(keymap.splitKeys('\x1b[1;5A'), ['\x1b[1;5A']);
});

test('normalizeKey maps Kitty-style names to keymap names', () => {
  assert.equal(keymap.normalizeKey('shift+g'), 'G');
  assert.equal(keymap.normalizeKey('space'), ' ');
  assert.equal(keymap.normalizeKey('j'), 'j');
});

test('action letters are not actions unless listed, and confirmation applies only to listed keys', () => {
  assert.deepEqual(run(['a'], { actions: ['a'] }), { type: 'action', key: 'a' });
  assert.deepEqual(run(['a'], { actions: [] }), { type: 'none' });
  assert.deepEqual(run(['/'], { actions: [] }), { type: 'none' });
  assert.deepEqual(run(['x'], { actions: ['x'] }), { type: 'action', key: 'x' });
});

test('moveIndex clamps to the list', () => {
  assert.equal(keymap.moveIndex(0, 3, 'up', 10), 0);
  assert.equal(keymap.moveIndex(2, 3, 'down', 10), 2);
  assert.equal(keymap.moveIndex(1, 30, 'half-down', 10), 6);
  assert.equal(keymap.moveIndex(0, 0, 'bottom', 10), 0);
});
