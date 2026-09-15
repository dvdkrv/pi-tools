import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { Type } from 'typebox';
import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { brokerFixture } from './helpers/broker.mjs';
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(process.env.PI_MESSAGING_PI_SDK || '@earendil-works/pi-coding-agent');
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../../extensions/messaging.ts');
const { connectBackend } = await jiti.import('../../src/messaging/nats-backend.ts');
const marker = 'QUIET_PEER_PAYLOAD';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate, label) {
  const end = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(10); }
}
async function fixture(t, holdAdmission = false) {
  const cleanups = []; const started = [deferred(), deferred()]; const release = [deferred(), deferred()];
  const admitted = deferred(); const releaseAdmission = deferred();
  let session; let reserveCalls = 0; let reservesInFlight = 0; let pendingStatus = false;
  t.after(async () => {
    for (const gate of release) gate.resolve(); releaseAdmission.resolve();
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const broker = await brokerFixture({ after: fn => cleanups.push(fn), skip: text => t.skip(text) }); if (!broker) return null;
  const sender = await connectBackend(broker.config, { initialize: true }); cleanups.push(() => sender.close());
  const receiver = await connectBackend(broker.config); cleanups.push(() => receiver.close());
  const group = await sender.createGroup('quiet'); await sender.join(group, { sessionId: 'sender', displayName: 'Sender' });
  const reserve = receiver.reserve.bind(receiver);
  receiver.reserve = async () => {
    reserveCalls++; reservesInFlight++;
    try {
      const r = await reserve();
      if (holdAdmission && r.length > 0) { admitted.resolve(); await releaseAdmission.promise; }
      return r;
    } finally { reservesInFlight--; }
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(broker.root, 'no-models.json'), signal: AbortSignal.timeout(15000) });
  await modelRuntime.setRuntimeApiKey('openai', 'scripted-test-only');
  const model = modelRuntime.getModel('openai', 'gpt-4.1-mini'); assert.ok(model);
  const requests = []; const errors = [];
  // Only the external provider is scripted. Pi lifecycle, tools, messaging and broker are real.
  modelRuntime.streamSimple = (_model, context) => {
    assert.ok(requests.length < 4, 'No polling or extra inference is allowed in this scripted work run');
    requests.push({ peer: JSON.stringify(context.messages).includes(marker) });
    const step = requests.length;
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: step <= 2 ? [{ type: 'toolCall', id: `work-${step}`, name: 'work', arguments: { step } }] : [{ type: 'text', text: 'done' }],
      stopReason: step <= 2 ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
  };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: broker.root, agentDir: broker.root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => registerMessaging(pi, async () => receiver, async () => {})] });
  await loader.reload();
  const created = await createAgentSession({ cwd: broker.root, agentDir: broker.root, modelRuntime, model, thinkingLevel: 'off',
    tools: ['work', 'peer_message'], resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(broker.root, join(broker.root, 'sessions')),
    customTools: [{ name: 'work', label: 'Work', description: 'A bounded test work step', parameters: Type.Object({ step: Type.Integer() }),
      execute: async (_id, { step }) => { assert.ok(step === 1 || step === 2); started[step - 1].resolve(); await release[step - 1].promise; return { content: [{ type: 'text', text: `step ${step} complete` }], details: {} }; } }] });
  session = created.session; assert.deepEqual(created.extensionsResult.errors, []);
  session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') errors.push(event.message.errorMessage);
  });
  await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: {
    confirm: async () => true, input: async () => { throw Error('Unexpected input'); },
    notify: (text, level) => { if (level === 'error' || level === 'warning') errors.push(text); },
    setStatus: (_key, text) => { if (text?.includes('1 pending')) pendingStatus = true; },
  } });
  await session.prompt('/messages join quiet'); assert.equal(requests.length, 0);
  await sender.arm(group, 1);
  return { sender, receiver, group, session, started, release, admitted, releaseAdmission, requests, errors, reserveCalls: () => reserveCalls, reservesInFlight: () => reservesInFlight, pendingStatus: () => pendingStatus };
}
async function finishWork(f) {
  f.release[0].resolve(); await f.started[1].promise;
  assert.equal(f.requests[1].peer, false, 'Peer content must not interrupt between work tool steps');
  f.release[1].resolve();
  await until(async () => !f.session.isStreaming && f.requests.length === 4 && (await f.sender.listMessages(f.group))[0].state === 'observed', 'idle peer delivery');
  assert.deepEqual(f.requests.map(r => r.peer), [false, false, false, true]);
  assert.equal((await f.sender.getGroupSummary(f.group)).used, 1); assert.deepEqual(f.errors, []);
}

test('real SDK keeps busy messages in the broker until the whole work run finishes', { timeout: 20000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const work = f.session.prompt('Do two steps of ordinary work'); await f.started[0].promise;
  // Allow any earlier empty idle pull to settle before measuring the busy interval.
  await until(() => f.reservesInFlight() === 0, 'pre-existing empty pull');
  const before = f.reserveCalls();
  await f.sender.send({ toPeerId: f.receiver.peer.id, text: marker }, 'busy');
  await until(f.pendingStatus, 'busy pending status');
  assert.equal(f.reserveCalls(), before, 'Busy notifications must not start a reservation');
  assert.equal((await f.sender.listMessages(f.group))[0].state, 'queued');
  assert.equal((await f.sender.getGroupSummary(f.group)).used, 0);
  await finishWork(f); await work;
});

test('real SDK queues an idle-to-busy admitted message after work rather than steering between steps', { timeout: 20000 }, async t => {
  const f = await fixture(t, true); if (!f) return;
  await f.sender.send({ toPeerId: f.receiver.peer.id, text: marker }, 'race');
  await f.admitted.promise;
  const work = f.session.prompt('Do two steps of ordinary work'); await f.started[0].promise;
  f.releaseAdmission.resolve(); await until(() => f.session.agent.hasQueuedMessages(), 'Pi queue after admission race');
  assert.equal((await f.sender.getGroupSummary(f.group)).used, 1);
  assert.equal((await f.sender.listMessages(f.group))[0].state, 'attempted');
  assert.equal(f.session.messages.some(m => m.role === 'custom' && m.customType === 'pi-messaging.peer.v1'), false);
  await finishWork(f); await work;
});
