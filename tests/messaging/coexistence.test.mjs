import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { default: loopExtension } = await jiti.import('../../extensions/loop.ts');
const { registerMessaging } = await jiti.import('../../extensions/messaging.ts');

test('messaging registration does not reset or govern the separate loop extension', async () => {
  const handlers = new Map(); const tools = new Map(); const commands = new Map();
  const entries = []; const userMessages = []; let connections = 0; let readiness = 0; let activeTools = [];
  const pi = {
    on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool: tool => { tools.set(tool.name, tool); activeTools.push(tool.name); }, registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => [...activeTools], setActiveTools: () => { throw new Error('neither extension may mutate active tools'); },
    registerMessageRenderer: () => {}, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (...args) => userMessages.push(args), sendMessage: () => { throw Error('Unjoined messaging must not deliver'); },
  };
  loopExtension(pi); registerMessaging(pi, async () => { connections++; throw Error('Unexpected broker connection'); }, async () => { readiness++; });
  const ctx = { mode: 'tui', ui: { notify: () => {}, setStatus: () => {} }, sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined };
  for (const handler of handlers.get('session_start')) await handler({}, ctx);
  await commands.get('loop').handler('start independent --max 3', ctx);
  await tools.get('loop_control').execute('continue', { action: 'continue' });
  await assert.rejects(tools.get('peer_message').execute('peers', { action: 'peers' }, undefined, undefined, ctx), /join/i);
  for (const handler of handlers.get('agent_settled')) await handler({}, ctx);
  assert.equal(entries.at(-1).data.iteration, 1);
  assert.equal(entries.at(-1).data.maxIterations, 3);
  assert.equal(entries.at(-1).data.active, true);
  assert.equal(userMessages.length, 2);
  assert.deepEqual(userMessages[1], ['independent', { deliverAs: 'followUp' }]);
  assert.equal(readiness, 1); assert.equal(connections, 0);
  assert.deepEqual(activeTools, ['loop_control', 'peer_message']);
  for (const handler of handlers.get('session_shutdown')) await handler({}, ctx);
});
