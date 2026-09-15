import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const sdk = await import(process.env.PI_LOOP_PI_SDK || '@earendil-works/pi-coding-agent');
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const loopExtension = (await createJiti(import.meta.url).import('../../extensions/loop.ts')).default;

async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('real Pi SDK terminates each loop decision and schedules exactly one next iteration', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-loop-sdk-'));
  let session;
  t.after(async () => {
    if (session) { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(root, 'no-models.json'),
    signal: AbortSignal.timeout(15_000),
  });
  await runtime.setRuntimeApiKey('openai', 'scripted-test-only');
  const model = runtime.getModel('openai', 'gpt-4.1-mini');
  assert.ok(model);

  const requests = [];
  runtime.streamSimple = (_model, context) => {
    assert.ok(requests.length < 2, 'terminating loop control must prevent repeated model calls');
    const index = requests.length;
    requests.push({
      systemPrompt: context.systemPrompt,
      tools: (context.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });
    const action = index === 0 ? 'continue' : 'stop';
    const message = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [{ type: 'toolCall', id: `loop-${index}`, name: 'loop_control', arguments: { action, reason: action === 'continue' ? 'one more' : 'done' } }],
      stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'toolUse', message });
    return stream;
  };

  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, enableInstallTelemetry: false });
  const sessionManager = SessionManager.create(root, join(root, 'sessions'));
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [loopExtension],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: root, agentDir: root, modelRuntime: runtime, model, thinkingLevel: 'off',
    tools: ['loop_control'], resourceLoader: loader, settingsManager, sessionManager,
  });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors = [];
  session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') errors.push(event.message.errorMessage);
  });
  await session.bindExtensions({
    mode: 'tui', onError: error => errors.push(error.error),
    uiContext: { notify: () => {}, setStatus: () => {} },
  });

  await session.prompt('/loop start bounded objective --max 3');
  await until(() => requests.length === 2 && !session.isStreaming, 'two terminating loop iterations');
  await delay(50);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt);
  assert.deepEqual(requests[0].tools, requests[1].tools);
  assert.ok(requests[0].tools.some(tool => tool.name === 'loop_control'));
  assert.equal(session.getActiveToolNames().includes('loop_control'), true);
  const states = sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'loop-state').map(entry => entry.data);
  assert.equal(states.filter(state => state.shouldContinue).length, 1);
  assert.equal(states.filter(state => state.continuedAt).length, 1);
  assert.equal(states.find(state => state.continuedAt).iteration, 1);
  assert.equal(states.at(-1).active, false);
  assert.equal(states.at(-1).reason, 'done');
  assert.deepEqual(errors, []);
});
