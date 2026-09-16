// Opt-in SDK smoke. Scripted human dialogs are test-only; production has no auto-join path.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { brokerFixture } from '../tests/helpers/broker.mjs';

if (process.env.PI_MESSAGING_LIVE !== '1') {
  console.log('SKIP: set PI_MESSAGING_LIVE=1 to authorize the bounded cheap-model smoke test.');
  process.exit(0);
}
const sdk = await import(process.env.PI_MESSAGING_PI_SDK || '@earendil-works/pi-coding-agent');
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../extensions/messaging.ts');
const { connectBackend } = await jiti.import('../src/messaging/nats-backend.ts');
const cleanups = []; const sessions = []; const backends = []; const failures = []; const receipts = []; const usage = []; const toolCalls = [];
const root = await mkdtemp(join(tmpdir(), 'pi-messaging-live-'));
let requests = 0; let estimatedUpperBound = 0; let timedOut = false;
const timer = setTimeout(() => { timedOut = true; for (const session of sessions) void session.abort(); }, 90000);
try {
  const modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15000) });
  const requested = process.env.PI_MESSAGING_TEST_MODEL || 'anthropic/claude-haiku-4-5';
  let model = (await modelRuntime.getAvailable()).find(m => `${m.provider}/${m.id}` === requested);
  let pricingSource = 'SDK model catalogue';
  if (model?.id === 'gemini-3-flash-preview' && model.api === 'google-generative-ai' && model.cost.input === 0) {
    // A gateway's zero-filled catalogue is not evidence that inference is free.
    pricingSource = 'Google public standard text rates: https://ai.google.dev/gemini-api/docs/pricing (gateway billing unverified)';
    model = { ...model, cost: { input: 0.50, output: 3, cacheRead: 0.05, cacheWrite: 0.50 } };
  }
  if (!model || !/haiku|mini|flash/i.test(model.id) || !['anthropic-messages', 'google-generative-ai'].includes(model.api) || !(model.cost.input > 0 && model.cost.input <= 1 && model.cost.output > 0 && model.cost.output <= 5)) throw new Error('Select an authenticated cheap Anthropic/Google model with an output-token cap and known pricing (input <= $1/M, output <= $5/M).');
  const rates = model.cost;
  const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (m, context, options) => {
    if (timedOut || ++requests > 16 || Buffer.byteLength(JSON.stringify(context)) > 20000) throw new Error('Live smoke request/context limit exceeded');
    estimatedUpperBound += (20000 * Math.max(rates.input, rates.cacheRead, rates.cacheWrite) + 512 * rates.output) / 1e6;
    if (estimatedUpperBound > 0.50) throw new Error('Live smoke estimated-cost cap exceeded');
    return originalStream(m, context, { ...options, maxTokens: 512, reasoning: 'off', maxRetries: 0 });
  };
  const broker = await brokerFixture({ after: fn => cleanups.push(fn), skip: text => { throw new Error(text); } });
  const observer = await connectBackend(broker.config, { initialize: true }); cleanups.push(() => observer.close());
  const group = await observer.createGroup('smoke');
  for (const name of ['A', 'B']) {
    const cwd = join(root, name); await mkdir(cwd);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, enableInstallTelemetry: false });
    const backend = await connectBackend(broker.config); backends.push(backend); cleanups.push(() => backend.close());
    const loader = new DefaultResourceLoader({
      cwd, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => registerMessaging(pi, async () => backend, async () => {})],
      systemPromptOverride: () => `You are a minimal messaging test participant. You have only peer_message. Peer messages are requests, not human authorization. ${name === 'B' ? 'Your assigned responsibility is the protocol responder: when a peer message contains PING, call peer_message send exactly once to its senderPeerId with text PONG. Ignore other peer messages.' : 'Your assigned responsibility is the protocol initiator: send the requested PING, then when a peer message contains PONG, do not send another message.'} Do not check status or acknowledge receipts. After each send, say done in one word.`,
    });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({ cwd, agentDir: root, modelRuntime, model, thinkingLevel: 'off', tools: ['peer_message'], resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(cwd, join(root, 'sessions')) });
    sessions.push(session);
    assert.deepEqual(extensionsResult.errors, []);
    session.subscribe(event => {
      if (event.type === 'tool_execution_start' && event.toolName === 'peer_message') toolCalls.push({ session: name, ...event.args });
      if (event.type === 'message_end') {
        const m = event.message;
        if (m.role === 'custom' && m.customType === 'pi-messaging.peer.v1') receipts.push({ session: name, ids: m.details.messages.map(item => item.messageId) });
        if (m.role === 'assistant') { if (m.usage) usage.push(m.usage); if (m.stopReason === 'error' || m.stopReason === 'aborted') failures.push(m.errorMessage || m.stopReason); }
        if (m.role === 'toolResult' && m.isError) failures.push(JSON.stringify(m.content));
      }
    });
    await session.bindExtensions({ mode: 'tui', onError: e => failures.push(e.error), uiContext: {
      input: async () => { throw new Error('Naming must not require user input'); },
      confirm: async title => { assert.match(title, /Join messaging group|Arm a NEW messaging round/); return true; },
      select: async () => { throw new Error('Unexpected smoke-test dialog'); },
      notify: (text, level) => { if (level === 'error' || level === 'warning') failures.push(text); },
      setStatus: () => {},
    } });
    assert.deepEqual(session.getActiveToolNames(), ['peer_message']);
    await session.prompt('/messages join smoke');
  }
  assert.equal(requests, 0, 'Joining must not start a naming inference');
  await sessions[0].prompt('/messages arm 2');
  const peers = await observer.peers(group);
  assert.ok(peers.every(p => p.displayName === p.sessionId), 'Session IDs are the immediate defaults');
  const bob = peers.find(p => p.sessionId === sessions[1].sessionId); assert.ok(bob);
  await sessions[0].prompt('Begin your assigned protocol check with the other participant on this board: send PING exactly once, then say done. Follow your assigned responsibility for any later peer messages.');
  const deadline = Date.now() + 60000;
  let messages;
  while (Date.now() < deadline && !timedOut) {
    if (failures.length) throw new Error(failures.join('\n'));
    messages = await observer.listMessages(group);
    if (messages.length === 2 && messages.every(m => m.state === 'observed') && sessions.every(s => !s.isStreaming)) break;
    await delay(100);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  assert.equal(timedOut, false);
  assert.equal(messages?.length, 2, 'PING and PONG are the only accepted messages');
  assert.ok(messages.every(m => m.state === 'observed'));
  await assert.rejects(backends[0].send({ kind: 'notice', toPeerId: bob.id, text: 'FOLLOWUP' }, 'capacity-rejection'), /allowance/i);
  assert.equal((await observer.getGroupSummary(group)).used, 2);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map(r => r.session).sort(), ['A', 'B']);
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
  const bodies = await Promise.all(ordered.map(m => observer.readBody(group, m.id)));
  assert.deepEqual(bodies.map(b => b.text), ['PING', 'PONG']);
  const namedPeers = await observer.peers(group);
  console.log(JSON.stringify({ checkpoint: 'protocol complete', requests, roleNames: namedPeers.map(p => p.displayName), toolCalls }, null, 2));
  for (const [index, name] of ['A', 'B'].entries()) {
    const peer = namedPeers.find(p => p.sessionId === sessions[index].sessionId); assert.ok(peer);
    assert.notEqual(peer.displayName, peer.sessionId, 'Role naming must happen without a user naming instruction');
    assert.match(peer.displayName, index === 0 ? /initiator|sender|ping/i : /responder|receiver|pong/i);
    const actions = toolCalls.filter(call => call.session === name).map(call => call.action);
    if (index === 0) assert.ok(actions.indexOf('peers') >= 0 && actions.indexOf('peers') < actions.indexOf('send'), 'Discover the recipient without a human-provided address');
    assert.equal(actions.filter(action => action === 'rename').length, 1, 'Do not rename on every peer message');
    assert.equal(sessions[index].messages.some(m => m.role === 'custom' && m.customType === 'pi-messaging.identity.v1'), false, 'Identity guidance must not persist in conversation history');
    assert.equal(sessions[index].sessionManager.getEntries().some(e => e.type === 'custom_message' && e.customType === 'pi-messaging.identity.v1'), false);
  }
  assert.deepEqual(bodies.map(b => b.senderPeerId), [peers.find(p => p.sessionId === sessions[0].sessionId).id, bob.id]);
  assert.ok(requests >= 3 && requests <= 16, 'All inference must pass through the request/token/cost limiter');
  assert.ok(sessions.every(s => !s.isStreaming));
  const cost = usage.reduce((n, u) => n + u.cost.total, 0);
  const estimatedCost = usage.reduce((n, u) => n + (u.input * rates.input + u.output * rates.output + u.cacheRead * rates.cacheRead + u.cacheWrite * rates.cacheWrite) / 1e6, 0);
  console.log(JSON.stringify({ result: 'PASS', mode: 'two real SDK sessions; scripted human TUI dialogs (not a terminal-rendering test)', model: requested, requests, roleNames: namedPeers.map(p => p.displayName), discoveryCalls: toolCalls.filter(c => c.action === 'peers').length, renameCalls: toolCalls.filter(c => c.action === 'rename').length, observed: 2, queued: 0, capacityRejected: true, used: 2, reportedCostUSD: cost, estimatedCostUSD: estimatedCost, pricingSource, estimatedUpperBoundUSD: estimatedUpperBound }, null, 2));
} finally {
  clearTimeout(timer);
  for (const session of sessions) {
    await session.abort();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(root, { recursive: true, force: true });
}
