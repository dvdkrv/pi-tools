import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../../extensions/messaging.ts');
const { connectBackend } = await jiti.import('../../src/messaging/nats-backend.ts');
const { brokerFixture } = await import('./helpers/broker.mjs');
const p = await jiti.import('../../src/messaging/policy.ts');
const { MessagingError } = await jiti.import('../../src/messaging/contracts.ts');

function fixture(t, { env = {}, mode = 'tui', saved = true, autoJoin = true, heartbeatMs = 5, retryDelay, ensureHook = async () => {} } = {}) {
  const state = p.newLedger(randomUUID()); const events = new Map(); const tools = new Map(); const commands = new Map();
  const notices = []; const statuses = []; const deliveries = []; const sentOptions = []; const maintainOptions = []; const audit = { records: [], states: [], prunes: [], open: [] };
  const bodies = new Map(); const registryNames = new Map([['session-one', 'Registry Name']]); const registryState = new Map();
  let settings = { autoJoin, sendsPerHour: 7, paused: false, retentionDays: 30, routeCooldownMinutes: 3 };
  let sessionId = 'session-one'; let peer; let lease; let closed = false; let ensureCalls = 0; let factoryCalls = 0; let reserveCalls = 0; let resumeCalls = 0; let reattachCalls = 0; let heartbeatError; let reattachError;
  const install = stored => { lease = p.leaseOf(stored); peer = p.publicPeer(stored); return peer; };
  const backend = {
    get peer() { return peer; }, get lease() { return lease; }, get closed() { return closed; },
    listGroups: async () => Object.values(state.groups).map(p.refOf), createGroup: async (label, options) => p.createGroup(state, label, options),
    getGroupSummary: async ref => p.summary(state, ref), peers: async ref => Object.values(state.peers).filter(x => x.groupId === ref.id).map(p.publicPeer),
    routes: async ref => Object.values(state.routes).filter(x => x.groupId === ref.id), setRoute: async (ref, from, to, value, recover) => p.setRoute(state, ref, from, to, value, recover),
    join: async (ref, info) => install(p.joinPeer(state, ref, info)), resume: async (ref, id, sessionId) => { resumeCalls++; return install(p.resumePeer(state, ref, sessionId, id)); }, takeover: async () => { throw Error('unexpected takeover'); },
    reattach: async (ref, current) => { reattachCalls++; if (reattachError) throw reattachError; return install(p.requireLease(state, current, ref)); },
    suspend: async () => { if (lease) p.suspendPeer(state, lease); peer = lease = undefined; }, leave: async () => { if (lease) p.leavePeer(state, lease); peer = lease = undefined; },
    close: async () => { closed = true; }, heartbeat: async name => { if (heartbeatError) { const error = heartbeatError; heartbeatError = undefined; throw error; } if (lease) { p.heartbeat(state, lease, name); peer = p.publicPeer(p.requireLease(state, lease)); } },
    arm: async (ref, limit) => p.arm(state, ref, limit), pause: async ref => p.pause(state, ref),
    maintain: async (ref, now, options) => { maintainOptions.push(options); p.maintain(state, now, options); }, onChange: () => () => {},
    reserve: async () => { reserveCalls++; if (!lease) return []; const ids = Object.values(state.messages).filter(x => x.recipientPeerId === peer.id && x.state === 'queued').map(x => x.id); return p.admitBatch(state, lease, ids).map(value => ({ ...value, envelope: p.envelope(state, state.messages[value.message.id], bodies.get(value.message.id) ?? '') })); },
    observe: async values => p.observeBatch(state, lease, values),
    send: async (input, key, options) => { sentOptions.push(options); const message = p.prepareMessage(state, lease, input, key, Date.now(), options); bodies.set(message.id, input.text); peer = p.publicPeer(p.requireLease(state, lease)); return message; },
    listMessages: async ref => Object.values(state.messages).filter(x => x.groupId === ref.id).sort((a, b) => b.sequence - a.sequence), readBody: async () => null,
    resolveMessage: async (ref, id, value) => p.resolveMessage(state, ref, id, value), revoke: async (ref, id) => p.revokePeer(state, ref, id), prune: async () => [],
  };
  const pi = { on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), registerMessageRenderer: () => {}, sendMessage: (...args) => deliveries.push(args) };
  const ctx = { mode, hasUI: mode === 'tui', cwd: '/tmp/example-repo', isIdle: () => true,
    sessionManager: { getSessionFile: () => saved ? '/tmp/session.jsonl' : undefined, getSessionId: () => sessionId },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args), select: async (_title, choices) => choices[0], confirm: async () => true, input: async () => '', editor: async () => 'body' } };
  registerMessaging(pi, async () => { factoryCalls++; closed = false; return backend; }, async () => { ensureCalls++; await ensureHook(); }, {
    env, heartbeatMs, retryDelay, settings: () => settings,
    registry: { displayName: id => registryNames.get(id), liveness: id => registryState.get(id) ?? 'live' },
    audit: { record: entry => audit.records.push(entry), openIds: () => audit.open, setStates: updates => audit.states.push(updates), prune: before => audit.prunes.push(before) },
  });
  t.after(async () => { await events.get('session_shutdown')?.({ reason: 'quit' }, ctx); });
  return { state, backend, events, tools, commands, notices, statuses, deliveries, sentOptions, maintainOptions, audit, ctx,
    setSettings: value => { settings = { ...settings, ...value }; }, setSessionId: value => { sessionId = value; },
    setRegistryName: (id, value) => registryNames.set(id, value), setLiveness: (id, value) => registryState.set(id, value),
    setBody: (id, value) => bodies.set(id, value), failHeartbeat: error => { heartbeatError = error; }, failReattach: error => { reattachError = error; },
    counts: () => ({ ensureCalls, factoryCalls, reserveCalls, resumeCalls, reattachCalls }) };
}
function value(result) { return JSON.parse(result.content[0].text); }
async function waitFor(predicate, message, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= end) assert.fail(message); await new Promise(resolve => setTimeout(resolve, 5)); }
}

for (const [name, options] of [['child run', { env: { PI_WORK_CHILD_RUN: 'C-1' } }], ['non-TUI mode', { mode: 'rpc' }], ['ephemeral session', { saved: false }], ['disabled setting', { autoJoin: false }]]) {
  test(`${name} does not auto-join`, async t => {
    const f = fixture(t, options); await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
    assert.equal(f.backend.peer, undefined);
    if (options.env) {
      assert.equal(f.tools.has('peer_message'), false);
      await assert.rejects(f.commands.get('messages').handler('join host', f.ctx), /child/i);
      assert.equal(f.counts().factoryCalls, 0);
    }
  });
}

test('host auto-join uses registry names, budget wiring, pause, audit, tree rejoin, and final leave', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.backend.peer.displayName, 'Registry Name');
  const group = Object.values(f.state.groups)[0]; assert.equal(group.label, 'host'); assert.equal(group.auto, true); assert.equal(group.routeCooldownMs, 180_000);
  const other = p.joinPeer(f.state, p.refOf(group), { sessionId: 'other', displayName: 'Other' });
  const tool = f.tools.get('peer_message');
  const result = await tool.execute('send-1', { action: 'send', kind: 'notice', toPeerId: other.id, text: 'SECRET BODY' }, undefined, undefined, f.ctx);
  assert.deepEqual(f.sentOptions.at(-1), { sendsPerHour: 7 });
  assert.equal(JSON.stringify(result).includes('SECRET BODY'), false);
  assert.equal(f.audit.records.length, 1); assert.equal(f.audit.records[0].body, 'SECRET BODY');
  const status = value(await tool.execute('status', { action: 'status' }, undefined, undefined, f.ctx));
  assert.deepEqual(status.budget, { left: 6, perHour: 7 });
  f.setSettings({ paused: true });
  await assert.rejects(tool.execute('send-2', { action: 'send', kind: 'notice', toPeerId: other.id, text: 'blocked' }, undefined, undefined, f.ctx), /paused by the user/i);
  f.setSettings({ paused: false });
  const oldId = f.backend.peer.id; await f.events.get('session_before_tree')({}, f.ctx); assert.equal(f.backend.peer, undefined);
  await f.events.get('session_tree')({}, f.ctx); assert.equal(f.backend.peer.id, oldId);
  await f.events.get('session_shutdown')({ reason: 'quit' }, f.ctx); assert.equal(f.state.peers[oldId].active, false);
});

test('a stale startup failure cannot detach its replacement session', async t => {
  let release; let ensureRuns = 0;
  const firstEnsure = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { ensureHook: async () => { if (++ensureRuns === 1) await firstEnsure; } });
  const stale = f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  await waitFor(() => f.counts().ensureCalls === 1, 'first startup did not enter ensure');
  f.setSessionId('session-two'); f.setRegistryName('session-two', 'Second Session');
  await f.events.get('session_start')({ reason: 'replacement' }, f.ctx);
  const replacementId = f.backend.peer.id;
  release(); await stale;
  assert.equal(f.backend.closed, false);
  assert.equal(f.backend.peer.id, replacementId);
  assert.equal(f.backend.peer.sessionId, 'session-two');
  assert.equal(f.notices.length, 0);
});

test('automatic recovery resumes its own suspended peer when the old lease rotated', { timeout: 2000 }, async t => {
  const f = fixture(t, { retryDelay: () => 0 }); await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  const id = f.backend.peer.id; p.suspendPeer(f.state, f.backend.lease);
  f.failReattach(new MessagingError('participation', 'lease rotated'));
  f.failHeartbeat(new Error('broker timeout'));
  await waitFor(() => f.counts().resumeCalls === 1 && f.counts().factoryCalls === 2, 'automatic participation did not resume after lease rotation');
  assert.equal(f.backend.peer.id, id); assert.equal(f.backend.peer.suspended, false); assert.equal(f.counts().reattachCalls, 1);
  assert.equal(f.notices.some(([, level]) => level === 'warning'), false);
});

test('reload suspends and the same session resumes the same auto-joined peer', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx); const id = f.backend.peer.id;
  await f.events.get('session_shutdown')({ reason: 'reload' }, f.ctx);
  assert.equal(f.state.peers[id].active, true); assert.equal(f.state.peers[id].suspended, true);
  await f.events.get('session_start')({ reason: 'reload' }, f.ctx);
  assert.equal(f.backend.peer.id, id); assert.equal(f.backend.peer.suspended, false);
});

test('replacement session leaves the old auto peer and joins a new identity', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx); const oldId = f.backend.peer.id;
  f.setSessionId('session-two'); f.setRegistryName('session-two', 'Second Session');
  await f.events.get('session_start')({ reason: 'new' }, f.ctx);
  assert.equal(f.state.peers[oldId].active, false); assert.notEqual(f.backend.peer.id, oldId);
  assert.equal(f.backend.peer.sessionId, 'session-two'); assert.equal(f.backend.peer.displayName, 'Second Session');
});

test('heartbeat refreshes registry state, syncs audit, prunes retention, revokes only stale ended peers, and renders auto status', async t => {
  const f = fixture(t); const joinedAt = Date.now(); await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.audit.prunes.length, 1);
  assert.ok(Math.abs(Date.parse(f.audit.prunes[0]) - (joinedAt - 30 * 24 * 60 * 60_000)) < 1000);
  const group = Object.values(f.state.groups)[0]; const ref = p.refOf(group);
  const onlineEnded = p.joinPeer(f.state, ref, { sessionId: 'online-ended', displayName: 'Online Ended' }); f.setLiveness('online-ended', 'ended');
  const discovery = value(await f.tools.get('peer_message').execute('peers', { action: 'peers' }, undefined, undefined, f.ctx));
  assert.equal(discovery.peers.find(peer => peer.id === onlineEnded.id).presence, 'offline');
  const staleEnded = p.joinPeer(f.state, ref, { sessionId: 'stale-ended', displayName: 'Stale Ended' });
  f.state.peers[staleEnded.id].lastSeen = Date.now() - p.ONLINE_WINDOW_MS - 1; f.setLiveness('stale-ended', 'ended');
  const sent = value(await f.tools.get('peer_message').execute('tick-send', { action: 'send', kind: 'notice', toPeerId: onlineEnded.id, text: 'audit body' }, undefined, undefined, f.ctx));
  f.audit.open.push(sent.id); f.setRegistryName('session-one', 'Refreshed Name');
  await waitFor(() => f.backend.peer?.displayName === 'Refreshed Name' && f.audit.states.some(batch => batch.some(update => update.id === sent.id)) && !f.state.peers[staleEnded.id].active,
    'heartbeat did not refresh name, sync audit, and revoke the stale ended peer');
  assert.equal(f.state.peers[onlineEnded.id].active, true);
  assert.ok(f.maintainOptions.some(options => options?.routeCooldownMs === 180_000));
  await waitFor(() => f.statuses.some(([, text]) => text === 'messages Refreshed Name: 6/7 sends left, 1 queued'), 'auto status was not rendered');
});

test('manual participation in the host group suspends on shutdown and does not run auto revoke', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  await f.commands.get('messages').handler('leave', f.ctx);
  await f.commands.get('messages').handler('join host', f.ctx);
  const group = Object.values(f.state.groups)[0]; const staleEnded = p.joinPeer(f.state, p.refOf(group), { sessionId: 'manual-ended', displayName: 'Manual Ended' });
  f.state.peers[staleEnded.id].lastSeen = Date.now() - p.ONLINE_WINDOW_MS - 1; f.setLiveness('manual-ended', 'ended');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.state.peers[staleEnded.id].active, true);
  const self = f.backend.peer.id; await f.events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
  assert.equal(f.state.peers[self].active, true); assert.equal(f.state.peers[self].suspended, true);
});

test('paused session lists match the registry display name and session-id prefix', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  const group = Object.values(f.state.groups)[0]; const other = p.joinPeer(f.state, p.refOf(group), { sessionId: 'other', displayName: 'Other' }); const tool = f.tools.get('peer_message');
  f.setSettings({ paused: ['Registry Name'] });
  await assert.rejects(tool.execute('name-pause', { action: 'send', kind: 'notice', toPeerId: other.id, text: 'blocked' }, undefined, undefined, f.ctx), /paused by the user/i);
  f.setSettings({ paused: ['session-'] });
  await assert.rejects(tool.execute('prefix-pause', { action: 'send', kind: 'notice', toPeerId: other.id, text: 'blocked' }, undefined, undefined, f.ctx), /paused by the user/i);
});

test('/messages pause and resume toggle sending, delivery readiness, and paused status in the auto group', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx); const group = Object.values(f.state.groups)[0]; const ref = p.refOf(group);
  const other = p.joinPeer(f.state, ref, { sessionId: 'other', displayName: 'Other' }); const tool = f.tools.get('peer_message');
  await waitFor(() => f.statuses.some(([, text]) => text === 'messages Registry Name: 7/7 sends left, 0 queued'), 'initial auto status was not rendered');
  await f.commands.get('messages').handler('pause', f.ctx);
  await assert.rejects(tool.execute('paused-send', { action: 'send', kind: 'notice', toPeerId: other.id, text: 'blocked' }, undefined, undefined, f.ctx), /paused by the user/i);
  await waitFor(() => f.statuses.some(([, text]) => text === 'messages Registry Name: paused'), 'paused status was not rendered');
  const incoming = p.prepareMessage(f.state, p.leaseOf(other), { kind: 'notice', toPeerId: f.backend.peer.id, text: 'wait until resumed' }, 'incoming'); f.setBody(incoming.id, 'wait until resumed');
  const reserves = f.counts().reserveCalls; await f.events.get('agent_settled')({}, f.ctx); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.counts().reserveCalls, reserves); assert.equal(f.deliveries.length, 0);
  await f.commands.get('messages').handler('resume', f.ctx); await waitFor(() => f.deliveries.length === 1, 'resume did not make queued delivery ready');
  const another = p.joinPeer(f.state, ref, { sessionId: 'another', displayName: 'Another' });
  const result = await tool.execute('resumed-send', { action: 'send', kind: 'notice', toPeerId: another.id, text: 'allowed' }, undefined, undefined, f.ctx);
  assert.equal(value(result).state, 'queued');
});

test('/messages send records the human-composed body in the audit log', async t => {
  const f = fixture(t); await f.events.get('session_start')({ reason: 'startup' }, f.ctx); const group = Object.values(f.state.groups)[0];
  p.joinPeer(f.state, p.refOf(group), { sessionId: 'other', displayName: 'Other' });
  await f.commands.get('messages').handler('send', f.ctx);
  assert.equal(f.audit.records.length, 1); assert.equal(f.audit.records[0].body, 'body'); assert.equal(f.audit.records[0].groupLabel, 'host');
});

test('rename is absent from the schema and rejected as an action', async t => {
  const f = fixture(t); const tool = f.tools.get('peer_message');
  assert.equal(tool.parameters.properties.action.enum.includes('rename'), false);
  assert.equal(Object.hasOwn(tool.parameters.properties, 'displayName'), false);
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  await assert.rejects(tool.execute('rename', { action: 'rename', displayName: 'other' }, undefined, undefined, f.ctx), /unknown.*action/i);
});

test('two broker-backed auto-joined extensions exchange one request and reply', { timeout: 20_000 }, async t => {
  const broker = await brokerFixture(t); if (!broker) return;
  const backends = [await connectBackend(broker.config, { initialize: true }), await connectBackend(broker.config)];
  const participants = backends.map((backend, index) => {
    const events = new Map(); const tools = new Map();
    const pi = { on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, registerMessageRenderer: () => {}, sendMessage: () => {} };
    const ctx = { mode: 'tui', hasUI: true, cwd: `/tmp/peer-${index}`, isIdle: () => false,
      sessionManager: { getSessionFile: () => `/tmp/peer-${index}.jsonl`, getSessionId: () => `peer-${index}` }, ui: { notify: () => {}, setStatus: () => {} } };
    registerMessaging(pi, async () => backend, async () => {}, { settings: () => ({ autoJoin: true, sendsPerHour: 10, paused: false, retentionDays: 30, routeCooldownMinutes: 10 }) });
    return { backend, events, tools, ctx };
  });
  t.after(async () => { for (const peer of participants) await peer.events.get('session_shutdown')({ reason: 'quit' }, peer.ctx); });
  for (const peer of participants) await peer.events.get('session_start')({ reason: 'startup' }, peer.ctx);
  const requestResult = value(await participants[0].tools.get('peer_message').execute('request', { action: 'send', kind: 'request', toPeerId: backends[1].peer.id, text: 'request body' }, undefined, undefined, participants[0].ctx));
  const admitted = await backends[1].reserve(); assert.equal(admitted.length, 1); await backends[1].observe(admitted);
  const replyResult = value(await participants[1].tools.get('peer_message').execute('reply', { action: 'send', kind: 'reply', toPeerId: backends[0].peer.id, text: 'reply body', inReplyTo: requestResult.id }, undefined, undefined, participants[1].ctx));
  assert.equal(replyResult.kind, 'reply'); assert.equal((await backends[0].listMessages((await backends[0].listGroups())[0])).length, 2);
});

test('a broker restart is recovered automatically with the same member identity and no ledger replay', { timeout: 30_000 }, async t => {
  const broker = await brokerFixture(t); if (!broker) return;
  await (await connectBackend(broker.config, { initialize: true })).close();
  const events = new Map(); const tools = new Map(); const statuses = []; const notices = []; let factories = 0;
  const pi = { on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, registerMessageRenderer: () => {}, sendMessage: () => {} };
  const ctx = { mode: 'tui', hasUI: true, cwd: '/tmp/restart', isIdle: () => true,
    sessionManager: { getSessionFile: () => '/tmp/restart.jsonl', getSessionId: () => 'restart' }, ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args) } };
  registerMessaging(pi, async () => { factories++; return connectBackend(broker.config); }, async () => {}, { heartbeatMs: 50, retryDelay: () => 100,
    settings: () => ({ autoJoin: true, sendsPerHour: 10, paused: false, retentionDays: 30, routeCooldownMinutes: 10 }) });
  t.after(async () => { await events.get('session_shutdown')({ reason: 'quit' }, ctx); });
  await events.get('session_start')({ reason: 'startup' }, ctx);
  const peers = async () => value(await tools.get('peer_message').execute('peers', { action: 'peers' }, undefined, undefined, ctx));
  const before = await peers();
  await broker.stop();
  await waitFor(() => statuses.some(([, text]) => /reconnecting/.test(text ?? '')), 'broker loss was not noticed', 5000);
  await broker.start();
  await waitFor(() => factories >= 2 && /^messages restart: \d+\/10 sends left/.test(statuses.at(-1)?.[1] ?? ''), `did not recover: ${JSON.stringify(statuses.at(-1))}`, 15_000);
  const after = await peers();
  assert.equal(after.selfId, before.selfId, 'the same member identity is reattached');
  assert.equal(notices.filter(([, level]) => level === 'warning').length, 0, 'transient loss shows status only');
});
