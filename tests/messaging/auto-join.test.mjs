import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../../extensions/messaging.ts');
const { connectBackend } = await jiti.import('../../src/messaging/nats-backend.ts');
const { brokerFixture } = await import('./helpers/broker.mjs');
const p = await jiti.import('../../src/messaging/policy.ts');

function fixture(t, { env = {}, mode = 'tui', saved = true, autoJoin = true } = {}) {
  const state = p.newLedger(randomUUID()); const events = new Map(); const tools = new Map(); const commands = new Map();
  const notices = []; const statuses = []; const sentOptions = []; const maintainOptions = []; const audit = { records: [], states: [], prunes: [], open: [] };
  let settings = { autoJoin, sendsPerHour: 7, paused: false, retentionDays: 30, routeCooldownMinutes: 3 };
  let peer; let lease; let closed = false; let ensureCalls = 0; let factoryCalls = 0;
  const install = stored => { lease = p.leaseOf(stored); peer = p.publicPeer(stored); return peer; };
  const backend = {
    get peer() { return peer; }, get closed() { return closed; },
    listGroups: async () => Object.values(state.groups).map(p.refOf), createGroup: async (label, options) => p.createGroup(state, label, options),
    getGroupSummary: async ref => p.summary(state, ref), peers: async ref => Object.values(state.peers).filter(x => x.groupId === ref.id).map(p.publicPeer),
    routes: async ref => Object.values(state.routes).filter(x => x.groupId === ref.id), setRoute: async (ref, from, to, value, recover) => p.setRoute(state, ref, from, to, value, recover),
    join: async (ref, info) => install(p.joinPeer(state, ref, info)), resume: async (ref, id, sessionId) => install(p.resumePeer(state, ref, sessionId, id)), takeover: async () => { throw Error('unexpected takeover'); },
    suspend: async () => { if (lease) p.suspendPeer(state, lease); peer = lease = undefined; }, leave: async () => { if (lease) p.leavePeer(state, lease); peer = lease = undefined; },
    close: async () => { closed = true; }, heartbeat: async name => { if (lease) { p.heartbeat(state, lease, name); peer = p.publicPeer(p.requireLease(state, lease)); } },
    arm: async (ref, limit) => p.arm(state, ref, limit), pause: async ref => p.pause(state, ref),
    maintain: async (ref, now, options) => { maintainOptions.push(options); p.maintain(state, now, options); }, onChange: () => () => {}, reserve: async () => [], observe: async () => {},
    send: async (input, key, options) => { sentOptions.push(options); const message = p.prepareMessage(state, lease, input, key, Date.now(), options); peer = p.publicPeer(p.requireLease(state, lease)); return message; },
    listMessages: async ref => Object.values(state.messages).filter(x => x.groupId === ref.id).sort((a, b) => b.sequence - a.sequence), readBody: async () => null,
    resolveMessage: async (ref, id, value) => p.resolveMessage(state, ref, id, value), revoke: async (ref, id) => p.revokePeer(state, ref, id), prune: async () => [],
  };
  const pi = { on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), registerMessageRenderer: () => {}, sendMessage: () => {} };
  const ctx = { mode, hasUI: mode === 'tui', cwd: '/tmp/example-repo', isIdle: () => true,
    sessionManager: { getSessionFile: () => saved ? '/tmp/session.jsonl' : undefined, getSessionId: () => 'session-one' },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args), select: async (_title, choices) => choices[0], confirm: async () => true, input: async () => '', editor: async () => 'body' } };
  registerMessaging(pi, async () => { factoryCalls++; closed = false; return backend; }, async () => { ensureCalls++; }, {
    env, settings: () => settings,
    registry: { displayName: id => id === 'session-one' ? 'Registry Name' : undefined, liveness: id => id === 'ended' ? 'ended' : 'live' },
    audit: { record: entry => audit.records.push(entry), openIds: () => audit.open, setStates: updates => audit.states.push(updates), prune: before => audit.prunes.push(before) },
  });
  t.after(async () => { await events.get('session_shutdown')?.({ reason: 'quit' }, ctx); });
  return { state, backend, events, tools, commands, notices, statuses, sentOptions, maintainOptions, audit, ctx,
    setSettings: value => { settings = { ...settings, ...value }; }, counts: () => ({ ensureCalls, factoryCalls }) };
}
function value(result) { return JSON.parse(result.content[0].text); }

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
  const group = Object.values(f.state.groups)[0]; assert.equal(group.label, 'host'); assert.equal(group.auto, true);
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
