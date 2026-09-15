import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const loop = await jiti.import('../../extensions/loop.ts');

function setup({ initialTools = ['read', 'loop_control'], failMessageAt } = {}) {
  const commands = new Map();
  const events = new Map();
  const entries = [];
  const messages = [];
  let activeTools = [...initialTools];
  let tool;
  loop.default({
    registerTool(definition) { tool = definition; },
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    on(name, handler) { events.set(name, handler); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage(message, options) {
      if (messages.length + 1 === failMessageAt) throw new Error('queue failed');
      messages.push({ message, options });
    },
    getActiveTools() { return [...activeTools]; },
    setActiveTools() { throw new Error('loop extension must not mutate active tools'); },
  });
  return {
    commands, events, entries, messages, activeTools: () => [...activeTools], tool,
    externalSetActiveTools(names) { activeTools = [...names]; },
  };
}

function context(entries = [], percent) {
  const notifications = [];
  const statuses = [];
  return {
    ctx: {
      sessionManager: { getBranch() { return entries; } },
      getContextUsage() {
        return percent === undefined ? undefined : { tokens: Math.round(percent), contextWindow: 100, percent };
      },
      ui: {
        notify(message, level) { notifications.push({ message, level }); },
        setStatus(name, value) { statuses.push({ name, value }); },
      },
    },
    notifications,
    statuses,
  };
}

const stateEntry = data => ({ type: 'custom', customType: 'loop-state', data });
const activeState = (extra = {}) => ({ active: true, prompt: 'keep going', iteration: 2, maxIterations: 7, shouldContinue: false, ...extra });

test('loop_control uses a Google-compatible string enum schema', () => {
  const { tool } = setup();
  assert.deepEqual(tool.parameters.properties.action, { type: 'string', enum: ['stop', 'continue'] });
});

test('loop tool has stationary cache-friendly prompt metadata', () => {
  const { tool } = setup();
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  assert.equal(Object.hasOwn(tool, 'promptGuidelines'), false);
});

test('active loop instruction is byte-stable across continuations', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start cache stable --max 3', c.ctx);
  const first = await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx);
  await f.tool.execute('decision', { action: 'continue' });
  await f.events.get('agent_settled')({}, c.ctx);
  const second = await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx);
  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.doesNotMatch(first.systemPrompt, /cache stable|iteration|3/);

  await f.commands.get('loop')('stop', c.ctx);
  assert.equal(await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx), undefined);
});

test('inactive stale decisions terminate without errors or persistence', async () => {
  const f = setup(); const c = context();
  await f.events.get('session_start')({ reason: 'startup' }, c.ctx);
  assert.deepEqual(f.activeTools(), ['read', 'loop_control']);
  for (const action of ['continue', 'stop']) {
    const result = await f.tool.execute('call', { action, reason: 'stale' });
    assert.equal(result.terminate, true); assert.match(result.content[0].text, /inactive|already/i);
  }
  assert.equal(f.entries.length, 0); assert.deepEqual(f.activeTools(), ['read', 'loop_control']);
});

test('human start and stop preserve every active tool and inactive stop is idempotent', async () => {
  const f = setup({ initialTools: ['read', 'bash', 'loop_control'] }); const c = context();
  await f.events.get('session_start')({ reason: 'startup' }, c.ctx);
  await f.commands.get('loop')('start inspect failures', c.ctx);
  assert.deepEqual(f.activeTools(), ['read', 'bash', 'loop_control']);
  assert.equal(f.entries.at(-1).data.maxIterations, 12); assert.equal(f.messages.length, 1);
  await f.commands.get('loop')('stop', c.ctx);
  assert.deepEqual(f.activeTools(), ['read', 'bash', 'loop_control']); const persisted = f.entries.length;
  await f.commands.get('loop')('stop', c.ctx);
  assert.equal(f.entries.length, persisted); assert.deepEqual(f.activeTools(), ['read', 'bash', 'loop_control']);
});

test('one terminating decision is persisted per iteration and duplicate calls are no-ops', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start bounded --max 3', c.ctx);
  const before = f.entries.length;
  const [first, duplicate] = await Promise.all([
    f.tool.execute('first', { action: 'continue', reason: 'more work' }),
    f.tool.execute('second', { action: 'stop', reason: 'parallel duplicate' }),
  ]);
  assert.equal(first.terminate, true); assert.equal(duplicate.terminate, true);
  assert.equal(f.entries.length, before + 1); assert.equal(f.entries.at(-1).data.shouldContinue, true);
  assert.equal(f.entries.filter(entry => entry.data.shouldContinue).length, 1);
  assert.equal(f.activeTools().includes('loop_control'), true);
});

test('agent_settled alone advances once and resets one decision for the next run', async () => {
  const f = setup(); const c = context();
  assert.ok(f.events.has('agent_end')); assert.ok(f.events.has('agent_settled'));
  await f.commands.get('loop')('start inspect failures --max 3', c.ctx);
  await f.tool.execute('call', { action: 'continue' });
  await f.events.get('agent_settled')({}, c.ctx);
  assert.deepEqual(f.messages, [
    { message: 'inspect failures', options: undefined },
    { message: 'inspect failures', options: { deliverAs: 'followUp' } },
  ]);
  assert.equal(f.entries.at(-1).data.iteration, 1); assert.ok(f.entries.at(-1).data.continuedAt);
  assert.equal(f.activeTools().includes('loop_control'), true);
  await f.events.get('agent_settled')({}, c.ctx);
  assert.equal(f.messages.length, 2); assert.equal(f.entries.at(-1).data.active, false);
});

test('maximum counts the initial run and prevents a follow-up at max one', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start once competing --max 1', c.ctx);
  await f.tool.execute('call', { action: 'continue' });
  await f.events.get('agent_settled')({}, c.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.entries.at(-1).data.active, false);
  assert.equal(f.entries.at(-1).data.iteration, 1); assert.match(f.entries.at(-1).data.reason, /max/i);
});

test('known context usage at 85 percent stops while lower or unknown usage may continue', async () => {
  for (const [percent, shouldContinue] of [[85, false], [84.9, true], [undefined, true]]) {
    const f = setup(); const c = context([], percent);
    await f.commands.get('loop')('start context guard --max 3', c.ctx);
    await f.tool.execute('call', { action: 'continue' });
    await f.events.get('agent_settled')({}, c.ctx);
    assert.equal(f.messages.length, shouldContinue ? 2 : 1, `percent=${percent}`);
    assert.equal(f.entries.at(-1).data.active, shouldContinue, `percent=${percent}`);
    if (!shouldContinue) assert.match(f.entries.at(-1).data.reason, /context/i);
  }
});

test('pre-compaction context high-water mark stops only when the run settles', async () => {
  const f = setup(); const high = context([], 91); const compacted = context([], 20);
  await f.commands.get('loop')('start context high water --max 3', high.ctx);
  await f.tool.execute('call', { action: 'continue' });
  await f.events.get('agent_end')({}, high.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.entries.at(-1).data.active, true);
  await f.events.get('agent_settled')({}, compacted.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.entries.at(-1).data.active, false);
  assert.match(f.entries.at(-1).data.reason, /context/i);
});

test('max parsing rejects zero, overflow, and malformed suffixes without mutation', async () => {
  for (const args of ['start objective --max 0', 'start objective --max 101', 'start objective --max nope', 'start objective --max 3 trailing']) {
    const f = setup(); const c = context();
    await f.commands.get('loop')(args, c.ctx);
    assert.equal(f.messages.length, 0, args); assert.equal(f.entries.length, 0, args);
    assert.match(c.notifications.at(-1).message, /1.*100|usage/i, args);
  }
});

test('start fails closed when loop_control is unavailable', async () => {
  const f = setup({ initialTools: ['read'] }); const c = context();
  await f.commands.get('loop')('start cannot run --max 3', c.ctx);
  assert.equal(f.messages.length, 0); assert.equal(f.entries.length, 0);
  assert.match(c.notifications.at(-1).message, /loop_control.*unavailable/i);
  assert.deepEqual(f.activeTools(), ['read']);
});

test('continuation fails closed if an external actor disables loop_control', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start bounded --max 3', c.ctx);
  await f.tool.execute('decision', { action: 'continue' });
  f.externalSetActiveTools(['read']);
  await f.events.get('agent_settled')({}, c.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.entries.at(-1).data.active, false);
  assert.match(f.entries.at(-1).data.reason, /unavailable/i);
  assert.ok(c.notifications.some(item => item.level === 'warning' && /unavailable/i.test(item.message)));
});

test('request preflight fails closed if loop_control became unavailable', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start bounded --max 3', c.ctx);
  f.externalSetActiveTools(['read']);
  const patch = await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx);
  assert.equal(patch, undefined); assert.equal(f.entries.at(-1).data.active, false);
  assert.equal(await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx), undefined);
  assert.match(f.entries.at(-1).data.reason, /unavailable/i); assert.equal(f.messages.length, 1);
  assert.ok(c.notifications.some(item => item.level === 'warning' && /unavailable/i.test(item.message)));
});

test('restoration fails closed when loop_control is unavailable', async () => {
  const f = setup({ initialTools: ['read'] }); const c = context([stateEntry(activeState())]);
  await f.events.get('session_start')({ reason: 'resume' }, c.ctx);
  assert.equal(f.entries.at(-1).data.active, false); assert.match(f.entries.at(-1).data.reason, /unavailable/i);
  assert.equal(f.messages.length, 0); assert.deepEqual(f.activeTools(), ['read']);
  assert.ok(c.notifications.some(item => item.level === 'warning' && /unavailable/i.test(item.message)));
});

test('initial enqueue failure stops rather than retaining active state', async () => {
  const f = setup({ failMessageAt: 1 }); const c = context();
  await f.commands.get('loop')('start queue initial safely --max 3', c.ctx);
  assert.equal(f.messages.length, 0); assert.equal(f.entries.at(-1).data.active, false);
  assert.match(f.entries.at(-1).data.reason, /initial/i); assert.equal(f.activeTools().includes('loop_control'), true);
  assert.ok(c.notifications.some(item => item.level === 'warning' && /initial/i.test(item.message)));
});

test('follow-up enqueue failure stops rather than retaining active state', async () => {
  const f = setup({ failMessageAt: 2 }); const c = context();
  await f.commands.get('loop')('start queue safely --max 3', c.ctx);
  await f.tool.execute('call', { action: 'continue' });
  await f.events.get('agent_settled')({}, c.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.entries.at(-1).data.active, false);
  assert.match(f.entries.at(-1).data.reason, /queue/i); assert.equal(f.activeTools().includes('loop_control'), true);
  assert.ok(c.notifications.some(item => item.level === 'warning' && /queue/i.test(item.message)));
});

test('session replacement without loop state cannot inherit the previous session loop', async () => {
  const f = setup(); const first = context();
  await f.commands.get('loop')('start do not inherit', first.ctx);
  assert.equal(f.activeTools().includes('loop_control'), true);
  const replacement = context([]);
  await f.events.get('session_start')({ reason: 'new' }, replacement.ctx);
  await f.commands.get('loop')('status', replacement.ctx);
  assert.match(replacement.notifications.at(-1).message, /inactive/i);
  assert.equal(f.activeTools().includes('loop_control'), true);
  assert.equal(f.messages.length, 1);
});

test('session restoration keeps waiting loops controllable and fails closed after an interrupted decision', async () => {
  const waiting = setup(); const c1 = context([stateEntry(activeState())]);
  await waiting.events.get('session_start')({ reason: 'resume' }, c1.ctx);
  assert.deepEqual(waiting.activeTools(), ['read', 'loop_control']);
  await waiting.commands.get('loop')('status', c1.ctx); assert.match(c1.notifications.at(-1).message, /iteration 2\/7/);

  const interrupted = setup(); const c2 = context([stateEntry(activeState({ shouldContinue: true }))]);
  await interrupted.events.get('session_start')({ reason: 'reload' }, c2.ctx);
  assert.equal(interrupted.entries.at(-1).data.active, false);
  assert.match(interrupted.entries.at(-1).data.reason, /interrupt/i);
  assert.deepEqual(interrupted.activeTools(), ['read', 'loop_control']); assert.equal(interrupted.messages.length, 0);
});
