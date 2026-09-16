import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { Type } from 'typebox';
import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { brokerFixture } from './helpers/broker.mjs';

const sdk = await import(process.env.PI_MESSAGING_PI_SDK || '@earendil-works/pi-coding-agent');
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../../extensions/messaging.ts');
const { connectBackend } = await jiti.import('../../src/messaging/nats-backend.ts');

async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}
function assistant(model, content, stopReason) {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function createReceiverSession(t, broker, receiver, streamSimple, customTools = []) {
  let session;
  t.after(async () => {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
  });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(broker.root, 'no-models.json'), signal: AbortSignal.timeout(15_000) });
  await runtime.setRuntimeApiKey('openai', 'scripted-test-only');
  const model = runtime.getModel('openai', 'gpt-4.1-mini'); assert.ok(model);
  runtime.streamSimple = (actualModel, context) => streamSimple(actualModel, context, model);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: broker.root, agentDir: broker.root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => registerMessaging(pi, async () => receiver, async () => {})] });
  await loader.reload();
  const created = await createAgentSession({ cwd: broker.root, agentDir: broker.root, modelRuntime: runtime, model, thinkingLevel: 'off',
    tools: ['peer_message', ...customTools.map(tool => tool.name)], customTools, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.create(broker.root, join(broker.root, 'sessions')) });
  session = created.session; assert.deepEqual(created.extensionsResult.errors, []);
  const errors = [];
  session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') errors.push(event.message.errorMessage);
  });
  await session.bindExtensions({ mode: 'tui', onError: error => errors.push(error.error), uiContext: {
    confirm: async () => true, input: async () => { throw new Error('Unexpected input'); },
    notify: (text, level) => { if (level === 'warning' || level === 'error') errors.push(text); }, setStatus: () => {},
  } });
  return { session, model, errors };
}

async function joinedBackends(t, label, senderCount) {
  const broker = await brokerFixture(t); if (!broker) return null;
  const senders = [];
  for (let index = 0; index < senderCount; index++) {
    const backend = await connectBackend(broker.config, { initialize: index === 0 }); t.after(() => backend.close()); senders.push(backend);
  }
  const receiver = await connectBackend(broker.config); t.after(() => receiver.close());
  const group = await senders[0].createGroup(label);
  for (let index = 0; index < senders.length; index++) await senders[index].join(group, { sessionId: `sender-${index}`, displayName: `Sender ${index}` });
  return { broker, senders, receiver, group };
}

test('three pending senders produce one combined peer turn and spend three credits', { timeout: 20_000 }, async t => {
  const f = await joinedBackends(t, 'batch-sdk', 3); if (!f) return;
  const requests = [];
  const receiverSession = await createReceiverSession(t, f.broker, f.receiver, (_actual, context, model) => {
    requests.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    const message = assistant(model, [{ type: 'text', text: 'batch handled' }], 'stop');
    stream.push({ type: 'done', reason: 'stop', message }); return stream;
  });
  await receiverSession.session.prompt('/messages join batch-sdk'); assert.equal(requests.length, 0);
  await f.senders[0].arm(f.group, 3); await f.senders[0].pause(f.group);
  const markers = ['BATCH_MARKER_1', 'BATCH_MARKER_2', 'BATCH_MARKER_3'];
  for (let index = 0; index < markers.length; index++) await f.senders[index].send({ kind: 'notice', toPeerId: f.receiver.peer.id, text: markers[index] }, `batch-${index}`);
  await f.senders[0].arm(f.group, 3);
  await until(async () => requests.length === 1 && !receiverSession.session.isStreaming &&
    (await f.senders[0].listMessages(f.group)).every(message => message.state === 'observed'), 'one observed batch turn');
  const request = JSON.stringify(requests[0]);
  for (const marker of markers) assert.equal(request.split(marker).length - 1, 1);
  assert.equal((await f.senders[0].getGroupSummary(f.group)).used, 3);
  assert.deepEqual(receiverSession.errors, []);
});

test('peer delivery remains append-only across a tool continuation', { timeout: 20_000 }, async t => {
  const f = await joinedBackends(t, 'cache-shape', 1); if (!f) return;
  const requests = []; let firstResponse;
  const work = { name: 'work', label: 'Work', description: 'Return one deterministic result', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'work complete' }], details: {} }) };
  const receiverSession = await createReceiverSession(t, f.broker, f.receiver, (_actual, context, model) => {
    const index = requests.length;
    const codexModel = { ...model, provider: 'openai-codex', api: 'openai-codex-responses' };
    requests.push({ messages: structuredClone(context.messages), systemPrompt: context.systemPrompt,
      tools: (context.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      codexInput: convertResponsesMessages(codexModel, context, new Set(['openai', 'openai-codex', 'opencode']), {
        includeSystemPrompt: false, deferredTools: new Map(),
        toolOptions: { strict: null, supportsStrictMode: true, supportsOpenAIGrammarTools: false },
      }) });
    const stream = createAssistantMessageEventStream();
    const message = index === 0
      ? assistant(model, [{ type: 'toolCall', id: 'cache-work', name: 'work', arguments: {} }], 'toolUse')
      : assistant(model, [{ type: 'text', text: 'done' }], 'stop');
    if (index === 0) firstResponse = structuredClone(message);
    stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
  }, [work]);
  await receiverSession.session.prompt('/messages join cache-shape'); assert.equal(requests.length, 0);
  await f.senders[0].arm(f.group, 1); await f.senders[0].pause(f.group);
  await f.senders[0].send({ kind: 'notice', toPeerId: f.receiver.peer.id, text: 'CACHE_APPEND_ONLY_MARKER' }, 'cache-message');
  await f.senders[0].arm(f.group, 1);
  await until(async () => requests.length === 2 && !receiverSession.session.isStreaming &&
    (await f.senders[0].listMessages(f.group))[0].state === 'observed', 'tool continuation and receipt');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt);
  assert.deepEqual(requests[0].tools, requests[1].tools);
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  assert.equal(requests[1].messages[requests[0].messages.length].role, 'assistant');
  const codexModel = { ...receiverSession.model, provider: 'openai-codex', api: 'openai-codex-responses' };
  const responseItems = convertResponsesMessages(codexModel, { messages: [firstResponse] }, new Set(['openai', 'openai-codex', 'opencode']), { includeSystemPrompt: false })
    .filter(item => item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output');
  const continuationPrefix = [...requests[0].codexInput, ...responseItems];
  assert.deepEqual(requests[1].codexInput.slice(0, continuationPrefix.length), continuationPrefix);
  assert.ok(requests[1].codexInput.slice(continuationPrefix.length).some(item => item.type === 'function_call_output'));
  const first = JSON.stringify(requests[0].messages); const second = JSON.stringify(requests[1].messages);
  assert.equal(first.split('CACHE_APPEND_ONLY_MARKER').length - 1, 1);
  assert.equal(second.split('CACHE_APPEND_ONLY_MARKER').length - 1, 1);
  for (const formerGuidance of ['Messaging identity (metadata only', 'Local messaging participation is shown below', 'pi-messaging.identity.v1']) {
    assert.equal(first.includes(formerGuidance), false); assert.equal(second.includes(formerGuidance), false);
    assert.equal(JSON.stringify(requests[1].codexInput).includes(formerGuidance), false);
  }
  assert.deepEqual(receiverSession.errors, []);
});
