import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const state = await jiti.import('../../src/theme/state.ts');

test('appearance parser accepts only trimmed light and dark', () => {
  assert.equal(state.parseAppearance(' light\n'), 'light');
  assert.equal(state.parseAppearance('dark'), 'dark');
  for (const value of [undefined, '', 'sepia', 'LIGHT', 'dark mode']) {
    assert.equal(state.parseAppearance(value), undefined);
  }
});

test('state path honors XDG_STATE_HOME and otherwise HOME', () => {
  assert.equal(state.resolveThemeStatePath({ XDG_STATE_HOME: '/xdg', HOME: '/home/test' }), '/xdg/theme');
  assert.equal(state.resolveThemeStatePath({ XDG_STATE_HOME: '', HOME: '/home/test' }), '/home/test/.local/state/theme');
});

test('initial appearance prefers state then environment then dark', () => {
  assert.equal(state.resolveInitialAppearance('/state', { LC_TERMINAL_THEME: 'dark' }, () => 'light\n'), 'light');
  assert.equal(state.resolveInitialAppearance('/state', { LC_TERMINAL_THEME: 'light' }, () => undefined), 'light');
  assert.equal(state.resolveInitialAppearance('/state', { LC_TERMINAL_THEME: 'sepia' }, () => 'invalid'), 'dark');
});

test('watcher catches a state change that landed before registration', () => {
  const changes = [];
  const dependencies = {
    read: () => 'dark\n',
    watch() {},
    unwatch() {},
  };

  state.watchAppearance('/state/theme', 'light', value => changes.push(value), dependencies);

  assert.deepEqual(changes, ['dark']);
});

test('watcher emits valid changes once and cleanup unregisters its listener', () => {
  let value = 'light\n';
  let listener;
  let unwatched;
  let unwatchCount = 0;
  const changes = [];
  const dependencies = {
    read: () => value,
    watch(_path, candidate) { listener = candidate; },
    unwatch(path, candidate) { unwatchCount += 1; unwatched = { path, candidate }; },
  };

  const close = state.watchAppearance('/state/theme', 'light', value => changes.push(value), dependencies);
  value = 'sepia\n'; listener();
  value = 'dark\n'; listener();
  listener();
  value = ''; listener();
  value = 'light\n'; listener();

  assert.deepEqual(changes, ['dark', 'light']);
  close();
  close();
  assert.equal(unwatchCount, 1);
  assert.deepEqual(unwatched, { path: '/state/theme', candidate: listener });
});
