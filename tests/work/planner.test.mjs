import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const planner = await load('src/work/planner.ts');
const { localDate } = await load('src/work/capture.ts');

const date = '2026-09-25';

test('outside tmux the planner command is printed with the kickoff prompt', () => {
  const action = planner.planPlannerLaunch({ date, cwd: '/home/u', insideTmux: false, windows: [], started: false });
  assert.equal(action.kind, 'print');
  assert.match(action.command, /^cd '\/home\/u' && PI_WORK_PLANNER=1 pi --session-id plan-2026-09-25 --name 'Plan 2026-09-25' '/);
  assert.match(action.command, /work_snapshot/);
});

test('inside tmux: focus today, rename stale windows, and omit the kickoff once started', () => {
  const focus = planner.planPlannerLaunch({ date, cwd: '/w', insideTmux: true, windows: [{ id: '@3', name: 'today', planDate: date }], started: true });
  assert.deepEqual(focus, { kind: 'focus', windowId: '@3' });
  const launch = planner.planPlannerLaunch({ date, cwd: '/w', insideTmux: true, windows: [{ id: '@2', name: 'today', planDate: '2026-09-24' }, { id: '@1', name: 'zsh', planDate: '' }], started: true });
  assert.equal(launch.kind, 'launch');
  assert.deepEqual(launch.renames, [['rename-window', '-t', '@2', 'plan-2026-09-24']]);
  assert.deepEqual(launch.create.slice(0, 8), ['new-window', '-P', '-F', '#{window_id}', '-n', 'today', '-c', '/w']);
  assert.doesNotMatch(launch.create[8], /work_snapshot/);
});

test('launchPlanner tags the new window, records the start, and refocuses next time', async () => {
  const store = await memoryStore();
  const today = localDate(store.clock());
  const windows = [];
  const calls = [];
  const tmux = (args) => {
    calls.push(args);
    if (args[0] === 'list-windows') return windows.map((w) => `${w.id}\t${w.name}\t${w.planDate}`).join('\n');
    if (args[0] === 'new-window') { windows.push({ id: '@7', name: 'today', planDate: '' }); return '@7\n'; }
    if (args[0] === 'set-option') { windows[0].planDate = args.at(-1); return ''; }
    return '';
  };
  const first = planner.launchPlanner({ store, cwd: '/w', env: { TMUX: '1' }, tmux, now: store.clock() });
  assert.equal(first.action, 'launch');
  assert.deepEqual(calls.find((c) => c[0] === 'set-option'), ['set-option', '-w', '-t', '@7', '@work-plan-date', today]);
  assert.equal(store.getMeta(`planner:started:${today}`), '1');
  const second = planner.launchPlanner({ store, cwd: '/w', env: { TMUX: '1' }, tmux, now: store.clock() });
  assert.equal(second.action, 'focus');
  assert.deepEqual(calls.at(-1), ['select-window', '-t', '@7']);
});

test('shellQuote handles apostrophes', () => {
  assert.equal(planner.shellQuote("user's plan"), `'user'\\''s plan'`);
});
