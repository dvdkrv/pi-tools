import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const askUser = await load('src/work/ask-user.ts');

const theme = { fg: (_color, text) => text, bold: (text) => text };

function harness(input) {
  const answers = [];
  let renders = 0;
  const component = askUser.askUserComponent(input, { requestRender: () => { renders++; } }, theme, (answer) => answers.push(answer));
  return {
    answers,
    press: (...keys) => { for (const key of keys) component.handleInput(key); },
    lines: () => component.render(80),
    text: () => component.render(80).join('\n'),
    renders: () => renders,
  };
}

const base = {
  question: 'Ship it?',
  options: [{ label: 'Ship now' }, { label: 'Wait', description: 'Hold for review' }, { label: 'Abandon' }],
};

const selectedLine = (h) => h.lines().find((line) => line.startsWith('> '));

test('the recommended option is marked and pre-selected', () => {
  const h = harness({ ...base, recommended: 1 });
  assert.match(h.text(), /2\. Wait \(recommended\)/);
  assert.match(selectedLine(h), /2\. Wait \(recommended\)/);
  assert.match(h.text(), /Hold for review/);
  assert.match(h.text(), /j\/k move • enter choose • esc dismiss/);
});

test('j/k and the arrow keys move and clamp at the ends', () => {
  const h = harness(base);
  assert.match(selectedLine(h), /1\. Ship now/);
  h.press('k');
  assert.match(selectedLine(h), /1\. Ship now/);
  h.press('j', '\x1b[B');
  assert.match(selectedLine(h), /3\. Abandon/);
  h.press('\x1b[B', 'j');
  assert.match(selectedLine(h), /Type something else…/);
  h.press('j', 'j');
  assert.match(selectedLine(h), /Type something else…/);
  h.press('g', 'g');
  assert.match(selectedLine(h), /1\. Ship now/);
  h.press('G');
  assert.match(selectedLine(h), /Type something else…/);
  h.press('\x1b[A');
  assert.match(selectedLine(h), /3\. Abandon/);
  assert.ok(h.renders() > 0);
});

test('Enter chooses the selected option by 0-based index and label', () => {
  const h = harness(base);
  h.press('j', '\r');
  assert.deepEqual(h.answers, [{ kind: 'option', index: 1, label: 'Wait' }]);
});

test('the other row opens text entry and Enter returns the trimmed text', () => {
  const h = harness(base);
  h.press('G', '\r');
  assert.match(h.text(), /Your answer:/);
  assert.match(h.text(), /enter submit • esc back/);
  h.press('m', 'a', 'y', 'b', 'e', ' ', '\r');
  assert.deepEqual(h.answers, [{ kind: 'other', text: 'maybe' }]);
});

test('Esc in text entry returns to the options without answering', () => {
  const h = harness(base);
  h.press('G', '\r', 'h', 'i', '\x1b');
  assert.deepEqual(h.answers, []);
  assert.doesNotMatch(h.text(), /Your answer:/);
  assert.match(selectedLine(h), /Type something else…/);
  h.press('\r');
  assert.match(h.text(), /Your answer:/);
  assert.doesNotMatch(h.text(), /hi/);
});

test('Enter with empty text leaves text entry', () => {
  const h = harness(base);
  h.press('G', '\r', '\r');
  assert.deepEqual(h.answers, []);
  assert.doesNotMatch(h.text(), /Your answer:/);
});

test('allow_other false removes the other row', () => {
  const h = harness({ ...base, allow_other: false });
  assert.doesNotMatch(h.text(), /Type something else/);
  h.press('G', '\r');
  assert.deepEqual(h.answers, [{ kind: 'option', index: 2, label: 'Abandon' }]);
});

test('Esc dismisses', () => {
  const h = harness(base);
  h.press('\x1b');
  assert.deepEqual(h.answers, [{ kind: 'dismissed' }]);
});

test('the context renders above the question', () => {
  const h = harness({ ...base, context: 'CI is red on main.' });
  const lines = h.lines();
  assert.ok(lines.findIndex((line) => line.includes('CI is red on main.')) < lines.findIndex((line) => line.includes('Ship it?')));
});

test('askUserNote lists the options and stays within the note limit', () => {
  assert.equal(askUser.askUserNote(base), 'Ship it? [Ship now / Wait / Abandon]');
  const long = askUser.askUserNote({ question: 'Q'.repeat(300), options: base.options });
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('… [Ship now / Wait / Abandon]'));
  const hugeOptions = askUser.askUserNote({ question: 'Pick', options: [{ label: 'A'.repeat(60) }, { label: 'B'.repeat(60) }, { label: 'C'.repeat(60) }] });
  assert.equal(hugeOptions.length, 200);
  assert.ok(hugeOptions.endsWith('…'));
});

test('askUserProblem flags an out-of-range recommended index', () => {
  assert.equal(askUser.askUserProblem(base), undefined);
  assert.equal(askUser.askUserProblem({ ...base, recommended: 2 }), undefined);
  assert.match(askUser.askUserProblem({ ...base, recommended: 3 }), /0-based index into options \(0 to 2\), got 3/);
  assert.match(askUser.askUserProblem({ ...base, recommended: -1 }), /got -1/);
});

test('an out-of-range recommended index is not marked or pre-selected', () => {
  const h = harness({ ...base, recommended: 9 });
  assert.doesNotMatch(h.text(), /recommended/);
  assert.match(selectedLine(h), /1\. Ship now/);
});

test('answerText covers every answer kind', () => {
  assert.equal(askUser.answerText({ kind: 'option', index: 1, label: 'Wait' }), 'The user chose "Wait" (option index 1).');
  assert.equal(askUser.answerText({ kind: 'other', text: 'maybe' }), 'The user answered in their own words: maybe');
  assert.equal(askUser.answerText({ kind: 'dismissed' }), askUser.ASK_USER_DISMISSED);
});
