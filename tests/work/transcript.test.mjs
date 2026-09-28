import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, tempDir } from './helpers.mjs';

const t = await load('src/work/transcript.ts');

const entry = (id, parentId, message) => JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-09-25T09:00:00.000Z', message });
const user = (text) => ({ role: 'user', content: text, timestamp: 1 });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }, { type: 'toolCall', id: 'c', name: 'bash', arguments: {} }] });

test('messageText joins text parts and ignores other parts', () => {
  assert.equal(t.messageText(user('hello')), 'hello');
  assert.equal(t.messageText(assistant('answer')), 'answer');
  assert.equal(t.messageText({ role: 'assistant', content: [{ type: 'image', data: 'x' }] }), '');
  assert.equal(t.messageText(null), '');
});

test('lastAssistantLine takes the last non-empty line of the latest assistant text', () => {
  assert.equal(t.lastAssistantLine([user('go'), assistant('Done with step one.\n\nShould I also update the docs?  \n')]), 'Should I also update the docs?');
  assert.equal(t.lastAssistantLine([assistant('Earlier question?'), { role: 'assistant', content: [{ type: 'toolCall' }] }]), 'Earlier question?');
  assert.equal(t.lastAssistantLine([user('only the user')]), '');
  assert.equal(t.lastAssistantLine([assistant('y'.repeat(300))]).length, 200);
});

test('parseTranscript follows the active branch and keeps user and assistant text only', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'uuid', timestamp: 'x', cwd: '/src/api' }),
    entry('a1', null, { role: 'system', content: '', sections: {} }),
    entry('a2', 'a1', user('first question')),
    entry('a3', 'a2', assistant('abandoned answer')),
    entry('a4', 'a2', assistant('kept answer')),
    entry('a5', 'a4', { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'tool output' }] }),
    'not json',
    entry('a6', 'a5', user('follow-up')),
  ];
  assert.deepEqual(t.parseTranscript(lines.join('\n')), [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'kept answer' },
    { role: 'user', text: 'follow-up' },
  ]);
  assert.deepEqual(t.parseTranscript(lines.join('\n'), 1), [{ role: 'user', text: 'follow-up' }]);
});

test('readTranscript reads the last 30 messages from a session file, and formatTranscript labels them', () => {
  const path = join(tempDir(), 'child.jsonl');
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(entry(`m${i}`, i === 0 ? null : `m${i - 1}`, i % 2 ? assistant(`reply ${i}`) : user(`ask ${i}`)));
  writeFileSync(path, `${lines.join('\n')}\n`);
  const messages = t.readTranscript(path);
  assert.equal(messages.length, 30);
  assert.deepEqual(messages[0], { role: 'user', text: 'ask 10' });
  assert.equal(t.formatTranscript(messages.slice(-2)), 'user:\n  ask 38\n\nassistant:\n  reply 39');
  assert.equal(t.formatTranscript([]), '(no messages yet)');
});
