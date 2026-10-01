import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const text = await load('src/work/dash/text.ts');
const w = await load('src/work/dash/widgets.ts');
const { frame } = await load('src/work/dash/terminal.ts');
const { plainStyle } = text;

function drive(make, keys) {
  let result = 'pending';
  const modal = make((value) => { result = value; });
  for (const key of keys) modal.handle(key);
  return { get result() { return result; }, modal };
}

test('widths ignore ANSI codes and count wide characters twice', () => {
  assert.equal(text.visibleWidth('\x1b[1mab\x1b[22m'), 2);
  assert.equal(text.visibleWidth('日本'), 4);
  assert.equal(text.stripAnsi(text.ansiStyle.inverse('x')), 'x');
});

test('truncate adds an ellipsis and fit pads to the width', () => {
  assert.equal(text.truncate('abcdef', 4), 'abc…');
  assert.equal(text.truncate('abc', 4), 'abc');
  assert.equal(text.truncate('abc', 0), '');
  assert.equal(text.truncate('日本語', 5), '日本…');
  assert.equal(text.fit('ab', 4), 'ab  ');
  assert.equal(text.fit('abcdef', 4), 'abc…');
});

test('sanitize and oneLine remove control characters, including escape sequences from external text', () => {
  assert.equal(text.sanitize('  a\x1b[2Jb'), '  a [2Jb');
  assert.equal(text.oneLine(' a\nb\tc\x1b[2Jd '), 'a b c [2Jd');
});

test('formatAge picks the largest sensible unit', () => {
  assert.equal(text.formatAge(45_000), '45s');
  assert.equal(text.formatAge(12 * 60_000), '12m');
  assert.equal(text.formatAge(3 * 3_600_000), '3h');
  assert.equal(text.formatAge(47 * 3_600_000), '47h');
  assert.equal(text.formatAge(5 * 86_400_000), '5d');
  assert.equal(text.formatAge(-5), '0s');
});

test('frame homes the cursor, clears each line end, and clears below', () => {
  assert.equal(frame(['a', 'b']), '\x1b[Ha\x1b[K\r\nb\x1b[K\x1b[J');
});

test('textPrompt edits, accepts, and cancels', () => {
  assert.equal(drive((r) => w.textPrompt('Title', 'keep', r), ['a', 'b', 'backspace', 'c', 'enter']).result, 'ac');
  assert.equal(drive((r) => w.textPrompt('Title', 'keep', r), ['enter']).result, '');
  assert.equal(drive((r) => w.textPrompt('Title', 'keep', r), ['a', 'escape']).result, undefined);
  const { modal } = drive((r) => w.textPrompt('Snooze days?', '3', r), []);
  assert.deepEqual(modal.lines(40, 10, plainStyle), ['Snooze days?', '> 3', 'enter accept · esc cancel']);
});

test('selectList moves with j and k and selects with Enter', () => {
  assert.equal(drive((r) => w.selectList('Project', ['misc', 'payments', 'web'], r), ['j', 'j', 'j', 'k', 'enter']).result, 'payments');
  assert.equal(drive((r) => w.selectList('Project', ['misc'], r), ['escape']).result, undefined);
  const { modal } = drive((r) => w.selectList('Project', ['misc', 'payments'], r), ['j']);
  assert.deepEqual(modal.lines(12, 10, plainStyle), ['Project', '  misc', '> payments  ']);
});

test('confirmBox accepts only y', () => {
  assert.equal(drive((r) => w.confirmBox('Delete?', 'x', r), ['y']).result, true);
  assert.equal(drive((r) => w.confirmBox('Delete?', 'x', r), ['n']).result, false);
  assert.equal(drive((r) => w.confirmBox('Delete?', 'x', r), ['j']).result, 'pending');
});

test('fuzzyPicker filters as you type and picks the highlighted item', () => {
  const items = [{ id: 'W-1', title: 'Fix flaky test' }, { id: 'W-2', title: 'Write docs' }, { id: 'W-3', title: 'Fix login' }];
  const label = (item) => `${item.id} ${item.title}`;
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['f', 'i', 'x', 'enter']).result.id, 'W-3');
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['f', 'i', 'x', 'down', 'enter']).result.id, 'W-1');
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['z', 'z', 'enter']).result, undefined);
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['escape']).result, undefined);
  const { modal } = drive((r) => w.fuzzyPicker('Link', items, label, r), ['d', 'o', 'c']);
  assert.deepEqual(modal.lines(30, 10, plainStyle).map((line) => line.trimEnd()), ['Link', '/ doc', '> W-2 Write docs', 'type to filter · ↑/↓ move · e…']);
});

test('messageBox scrolls with j and k, keeps indentation, and closes on any other key', () => {
  const body = Array.from({ length: 10 }, (_, i) => `  line ${i}`).join('\n');
  const box = drive((r) => w.messageBox('Details', body, r), ['j', 'j']);
  assert.equal(box.result, 'pending');
  assert.deepEqual(box.modal.lines(20, 5, plainStyle).slice(0, 3), ['Details', '  line 2', '  line 3']);
  box.modal.handle('x');
  assert.equal(box.result, undefined);
  const tail = drive((r) => w.messageBox('Transcript', body, r, { atEnd: true }), []);
  assert.deepEqual(tail.modal.lines(20, 5, plainStyle).slice(1, 4), ['  line 7', '  line 8', '  line 9']);
  const wrapped = drive((r) => w.messageBox('Message', '0123456789abcdefghij', r, { wrap: true }), []);
  assert.deepEqual(wrapped.modal.lines(10, 6, plainStyle).slice(1, 3), ['0123456789', 'abcdefghij']);
});
