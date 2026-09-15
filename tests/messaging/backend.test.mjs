import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createJiti } from 'jiti';
import { connect } from '@nats-io/transport-node';
import { Kvm } from '@nats-io/kv';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../../src/messaging/nats-backend.ts');
const { MessagingError } = await createJiti(import.meta.url).import('../../src/messaging/contracts.ts');
const consumerName = peerId => `peer_${peerId.replaceAll('-', '')}`;
async function fixture(t) {
  const f = await brokerFixture(t); if (!f) return null;
  const a = await connectBackend(f.config, { initialize: true }); t.after(() => a.close());
  const b = await connectBackend(f.config); t.after(() => b.close());
  const g = await a.createGroup('testing');
  await a.join(g, { sessionId: 'a', displayName: 'Alice' }); await b.join(g, { sessionId: 'b', displayName: 'Bob' });
  return { ...f, a, b, g };
}

test('migrates v1 ledger once before backend exposure without losing initialized state', async t => {
  const f = await brokerFixture(t); if (!f) return;
  const initializer = await connectBackend(f.config, { initialize: true }); await initializer.close();
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  const kv = await new Kvm(nc).open('PM_CONTROL');
  const groupId = randomUUID(); const senderId = randomUUID(); const recipientId = randomUUID(); const otherSenderId = randomUUID();
  const queuedId = randomUUID(); const attemptedId = randomUUID(); const attemptId = randomUUID();
  const legacy = {
    version: 1, authorityId: f.config.authorityId, sequence: 2,
    groups: {
      [groupId]: { authorityId: f.config.authorityId, id: groupId, label: 'legacy-backend', mode: 'armed', round: 4, limit: 5, used: 1 },
    },
    peers: {
      [senderId]: { id: senderId, groupId, sessionId: 'legacy-sender', displayName: 'Legacy Sender', active: true, lastSeen: 1_000 },
      [recipientId]: { id: recipientId, groupId, sessionId: 'legacy-recipient', displayName: 'Legacy Recipient', active: true, lastSeen: 1_001 },
      [otherSenderId]: { id: otherSenderId, groupId, sessionId: 'legacy-other', displayName: 'Legacy Other', active: false, lastSeen: 999 },
    },
    messages: {
      [queuedId]: { id: queuedId, sequence: 1, groupId, senderPeerId: senderId, recipientPeerId: recipientId, senderName: 'Legacy Sender', requestKey: 'legacy-queued', hash: '1'.repeat(64), createdAt: 1_010, state: 'queued' },
      [attemptedId]: { id: attemptedId, sequence: 2, groupId, senderPeerId: otherSenderId, recipientPeerId: recipientId, senderName: 'Legacy Other', requestKey: 'legacy-attempted', hash: '2'.repeat(64), createdAt: 1_020, state: 'attempted', inReplyTo: queuedId, attemptId, attemptRound: 4, attemptedAt: 1_021 },
    },
  };
  const initialized = await kv.get('state');
  await kv.update('state', JSON.stringify(legacy), initialized.revision);
  const before = await kv.get('state');

  const upgraded = await connectBackend(f.config); t.after(() => upgraded.close());
  const after = await kv.get('state'); const current = after.json();
  assert.equal(after.revision, before.revision + 1, 'migration must commit exactly one KV revision');
  assert.equal(current.version, 2);
  const projection = {
    ...current, version: 1,
    peers: Object.fromEntries(Object.entries(current.peers).map(([id, { suspended, leaseId, ...peer }]) => [id, peer])),
  };
  assert.equal(JSON.stringify(projection), JSON.stringify(legacy), 'all v1 JSON fields and ordering must survive migration');
  assert.ok(Object.values(current.peers).every(peer => peer.suspended === false && /^[0-9a-f-]{36}$/.test(peer.leaseId)));
  await upgraded.close();

  const reconnected = await connectBackend(f.config); t.after(() => reconnected.close());
  assert.equal((await kv.get('state')).revision, after.revision, 'v2 reconnect must not write another migration revision');
});

test('resumes a preserved durable inbox as one ordered three-message batch', async t => {
  const f = await fixture(t); if (!f) return;
  const senders = [f.a];
  for (let index = 1; index < 3; index++) {
    const sender = await connectBackend(f.config); t.after(() => sender.close());
    await sender.join(f.g, { sessionId: `resume-sender-${index}`, displayName: `Resume Sender ${index}` });
    senders.push(sender);
  }
  await f.a.arm(f.g, 3);
  const original = f.b.peer; const sent = [];
  for (let index = 0; index < senders.length; index++) sent.push(await senders[index].send({ toPeerId: original.id, text: `preserved-${index}` }, `preserved-${index}`));
  const beforeInfo = await f.a.jsm.consumers.info('PM_MESSAGES', consumerName(original.id));
  const beforeCount = (await f.a.jsm.streams.info('PM_MESSAGES')).state.consumer_count;

  await f.b.suspend(); await f.b.close();
  const replacement = await connectBackend(f.config); t.after(() => replacement.close());
  const resumed = await replacement.resume(f.g, original.id, original.sessionId);
  assert.deepEqual(resumed, replacement.peer);
  assert.deepEqual({ id: resumed.id, groupId: resumed.groupId, sessionId: resumed.sessionId, displayName: resumed.displayName },
    { id: original.id, groupId: original.groupId, sessionId: original.sessionId, displayName: original.displayName });
  assert.equal(Object.hasOwn(resumed, 'leaseId'), false);
  assert.ok((await replacement.peers(f.g)).every(peer => !Object.hasOwn(peer, 'leaseId')));
  const listed = (await replacement.listMessages(f.g)).sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(listed.map(message => [message.id, message.sequence, message.recipientPeerId]), sent.map(message => [message.id, message.sequence, original.id]));
  assert.equal((await f.a.jsm.streams.info('PM_MESSAGES')).state.consumer_count, beforeCount);
  const afterInfo = await f.a.jsm.consumers.info('PM_MESSAGES', consumerName(original.id));
  assert.deepEqual({
    stream: afterInfo.stream_name, durable: afterInfo.config.durable_name, subject: afterInfo.config.filter_subject,
    ack: afterInfo.config.ack_policy, deliver: afterInfo.config.deliver_policy,
    maxAckPending: afterInfo.config.max_ack_pending, ackWait: afterInfo.config.ack_wait,
  }, {
    stream: 'PM_MESSAGES', durable: consumerName(original.id), subject: `pm.message.${f.g.id}.${original.id}.*`,
    ack: 'explicit', deliver: 'all', maxAckPending: 8, ackWait: 5_000_000_000,
  });
  assert.equal(afterInfo.created.toISOString?.() ?? afterInfo.created, beforeInfo.created.toISOString?.() ?? beforeInfo.created, 'resume must retain the existing durable');

  const batch = await replacement.reserve();
  assert.deepEqual(batch.map(item => item.message.id), sent.map(message => message.id));
  assert.deepEqual(batch.map(item => item.envelope.text), ['preserved-0', 'preserved-1', 'preserved-2']);
  assert.equal((await replacement.getGroupSummary(f.g)).used, 3);
  await replacement.observe(batch);
  assert.ok((await replacement.listMessages(f.g)).every(message => message.state === 'observed'));
});

test('rejected resume of a left peer does not recreate its durable', async t => {
  const f = await fixture(t); if (!f) return;
  const departed = f.b.peer; const name = consumerName(departed.id);
  await f.b.leave();
  const before = (await f.a.jsm.streams.info('PM_MESSAGES')).state.consumer_count;
  await assert.rejects(f.a.jsm.consumers.info('PM_MESSAGES', name));

  const replacement = await connectBackend(f.config); t.after(() => replacement.close());
  await assert.rejects(replacement.resume(f.g, departed.id, departed.sessionId), /left|revoked|participation/i);
  assert.equal((await f.a.jsm.streams.info('PM_MESSAGES')).state.consumer_count, before);
  await assert.rejects(f.a.jsm.consumers.info('PM_MESSAGES', name));
});

test('resume CAS rejection after creating a durable removes the now-inactive orphan', async t => {
  const f = await fixture(t); if (!f) return;
  const original = f.b.peer; const name = consumerName(original.id);
  await f.b.suspend(); await f.b.close();
  await f.a.jsm.consumers.delete('PM_MESSAGES', name);
  const before = (await f.a.jsm.streams.info('PM_MESSAGES')).state.consumer_count;
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  const kv = await new Kvm(nc).open('PM_CONTROL');
  const replacement = await connectBackend(f.config); t.after(() => replacement.close());
  const bind = replacement.bindConsumer.bind(replacement);
  replacement.bindConsumer = async (...args) => {
    const binding = await bind(...args);
    const entry = await kv.get('state'); const state = entry.json();
    state.peers[original.id].active = false; state.peers[original.id].suspended = false;
    state.peers[original.id].leaseId = randomUUID();
    await kv.update('state', JSON.stringify(state), entry.revision);
    return binding;
  };

  await assert.rejects(replacement.resume(f.g, original.id, original.sessionId), /left|revoked|participation/i);
  assert.equal((await f.a.jsm.streams.info('PM_MESSAGES')).state.consumer_count, before);
  await assert.rejects(f.a.jsm.consumers.info('PM_MESSAGES', name));
});

test('definite consumer bind rejection finalizes a fresh joined identity', async t => {
  const f = await fixture(t); if (!f) return;
  const joining = await connectBackend(f.config); t.after(() => joining.close());
  const beforeActive = (await f.a.peers(f.g)).filter(peer => peer.active).length;
  joining.bindConsumer = async () => { throw new MessagingError('configuration', 'forced definite bind rejection'); };

  await assert.rejects(joining.join(f.g, { sessionId: 'failed-join', displayName: 'Failed Join' }), /forced definite bind rejection/);
  assert.equal(joining.peer, undefined);
  const peers = await f.a.peers(f.g);
  assert.equal(peers.filter(peer => peer.active).length, beforeActive);
  assert.equal(peers.find(peer => peer.sessionId === 'failed-join')?.active, false);
});

test('resume rejects behavior-changing preserved consumer configuration', async t => {
  const f = await fixture(t); if (!f) return;
  const original = f.b.peer; const name = consumerName(original.id);
  await f.b.suspend(); await f.b.close();
  await f.a.jsm.consumers.update('PM_MESSAGES', name, { max_deliver: 1 });

  const replacement = await connectBackend(f.config); t.after(() => replacement.close());
  await assert.rejects(replacement.resume(f.g, original.id, original.sessionId), /consumer configuration/i);
  const current = (await f.a.peers(f.g)).find(peer => peer.id === original.id);
  assert.equal(current.suspended, true);
});

test('heartbeat keeps the cached public peer identical to committed normalized state', async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.heartbeat('  Alice Updated  ');
  const stored = (await f.b.peers(f.g)).find(peer => peer.id === f.a.peer.id);
  assert.deepEqual(f.a.peer, stored);
  assert.equal(f.a.peer.displayName, 'Alice Updated');
});

test('attempted message and allowance survive suspend and resume until explicit dismissal', async t => {
  const f = await fixture(t); if (!f) return;
  const sender = await connectBackend(f.config); t.after(() => sender.close());
  await sender.join(f.g, { sessionId: 'waiting-sender', displayName: 'Waiting Sender' });
  await f.a.arm(f.g, 2);
  const attemptedMessage = await f.a.send({ toPeerId: f.b.peer.id, text: 'attempted' }, 'attempted-before-resume');
  const reservation = (await f.b.reserve())[0];
  const waiting = await sender.send({ toPeerId: f.b.peer.id, text: 'waiting' }, 'waiting-before-resume');
  const original = f.b.peer;
  const beforeAttempt = (await f.a.listMessages(f.g)).find(message => message.id === attemptedMessage.id);
  const beforeSummary = await f.a.getGroupSummary(f.g);

  await f.b.suspend(); await f.b.close();
  const replacement = await connectBackend(f.config); t.after(() => replacement.close());
  await replacement.resume(f.g, original.id, original.sessionId);
  assert.deepEqual(await replacement.reserve(), []);
  const afterAttempt = (await replacement.listMessages(f.g)).find(message => message.id === attemptedMessage.id);
  assert.deepEqual(afterAttempt, beforeAttempt);
  assert.deepEqual(await replacement.getGroupSummary(f.g), beforeSummary);
  assert.equal(afterAttempt.attemptId, reservation.attemptId);
  assert.equal(afterAttempt.attemptRound, reservation.round);

  await replacement.resolveMessage(f.g, attemptedMessage.id, 'dismissed');
  assert.equal((await replacement.getGroupSummary(f.g)).used, 1, 'dismissal must not refund the attempted credit');
  const next = await replacement.reserve();
  assert.deepEqual(next.map(item => item.message.id), [waiting.id]);
  assert.equal((await replacement.getGroupSummary(f.g)).used, 2);
});

test('real queue: opt-in, shared allowance, exact envelope, idempotency and terminal recovery', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  const c = await connectBackend(f.config); t.after(() => c.close());
  await c.join(g, { sessionId: 'c', displayName: 'Carol' });
  const input = { toPeerId: b.peer.id, text: 'Hello Bob' };
  await assert.rejects(a.send(input, 'before-arm'), /allowance|capacity/i);
  await a.arm(g, 2);
  const m = await a.send(input, 'call-1');
  assert.equal((await a.send(input, 'call-1')).id, m.id);
  await assert.rejects(a.send({ ...input, text: 'changed' }, 'call-1'), /conflict/i);
  const first = await b.reserve(); assert.equal(first.length, 1);
  assert.equal(first[0].message.id, m.id); assert.equal(first[0].envelope.text, 'Hello Bob');
  assert.equal((await a.getGroupSummary(g)).used, 1);
  const second = await c.send(input, 'call-2');
  assert.deepEqual(await b.reserve(), []);
  await b.observe(first); const secondBatch = await b.reserve(); assert.equal(secondBatch[0].message.id, second.id);
  await a.resolveMessage(g, second.id, 'dismissed');
  await assert.rejects(a.send(input, 'call-3'), /allowance|capacity/i);
  assert.equal((await a.getGroupSummary(g)).mode, 'exhausted');
  await a.arm(g, 1); const third = await a.send(input, 'call-3');
  const thirdBatch = await b.reserve(); assert.equal(thirdBatch[0].message.id, third.id);
  assert.equal((await a.listMessages(g)).length, 3);
});

test('real queue admits eight distinct senders to one recipient as one ordered batch', async t => {
  const f = await fixture(t); if (!f) return;
  const senders = [f.a];
  for (let i = 1; i < 8; i++) {
    const sender = await connectBackend(f.config); t.after(() => sender.close());
    await sender.join(f.g, { sessionId: `sender-${i}`, displayName: `Sender ${i}` }); senders.push(sender);
  }
  await f.a.arm(f.g, 8);
  const sent = [];
  for (let i = 0; i < senders.length; i++) sent.push(await senders[i].send({ toPeerId: f.b.peer.id, text: `batch-${i}` }, `batch-${i}`));
  const batch = await f.b.reserve();
  assert.deepEqual(batch.map(r => r.message.id), sent.map(m => m.id));
  assert.deepEqual(batch.map(r => r.envelope.text), senders.map((_, i) => `batch-${i}`));
  assert.equal((await f.a.getGroupSummary(f.g)).used, 8);
  assert.ok((await f.a.listMessages(f.g)).every(m => m.state === 'attempted'));
});

test('role tool publishes self-name without rerouting queued work or inheriting an old session inbox', async t => {
  const f = await fixture(t); if (!f) return;
  const { registerMessaging } = await createJiti(import.meta.url).import('../../extensions/messaging.ts');
  const commands = new Map(); const tools = new Map(); const events = new Map(); const delivered = [];
  const ctx = { mode: 'tui', isIdle: () => false,
    sessionManager: { getSessionFile: () => '/tmp/naming-session.jsonl', getSessionId: () => 'a' },
    ui: { confirm: async () => true, input: async () => { throw Error('No name input'); }, notify: () => {}, setStatus: () => {} } };
  registerMessaging({ on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer: () => {}, getActiveTools: () => ['peer_message'],
    sendMessage: (...args) => delivered.push(args) }, async () => f.a, async () => {});
  t.after(() => events.get('session_shutdown')({}, ctx));
  await f.a.leave(); await commands.get('messages').handler('join testing', ctx);
  const oldId = f.a.peer.id; await f.a.arm(f.g, 3);
  const before = await f.a.send({ toPeerId: f.b.peer.id, text: 'before rename' }, 'before');
  const incoming = await f.b.send({ toPeerId: oldId, text: 'old inbox' }, 'incoming');
  await f.b.observe(await f.b.reserve());
  await tools.get('peer_message').execute('role', { action: 'rename', displayName: 'test-reviewer', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 }, undefined, undefined, ctx);
  const discovered = (await f.b.peers(f.g)).find(p => p.id === oldId);
  assert.equal(discovered.sessionId, 'a'); assert.equal(discovered.displayName, 'test-reviewer');
  assert.equal(f.a.peer.displayName, 'test-reviewer');
  const sent = await tools.get('peer_message').execute('after', { action: 'send', toPeerId: f.b.peer.id, text: 'after rename', inReplyTo: '', beforeSequence: 1 }, undefined, undefined, ctx);
  const after = (await f.a.listMessages(f.g)).find(m => m.id === JSON.parse(sent.content[0].text).id);
  assert.equal(after.inReplyTo, undefined);
  assert.equal((await f.b.readBody(f.g, before.id)).senderName, 'a');
  assert.equal((await f.b.readBody(f.g, after.id)).senderName, 'test-reviewer');
  assert.equal(after.senderPeerId, before.senderPeerId);
  await commands.get('messages').handler('leave', ctx);
  await commands.get('messages').handler('join testing', ctx);
  assert.notEqual(f.a.peer.id, oldId); assert.equal(f.a.peer.sessionId, 'a'); assert.equal(f.a.peer.displayName, 'a');
  const oldInbox = (await f.a.listMessages(f.g)).find(m => m.id === incoming.id);
  assert.equal(oldInbox.recipientPeerId, oldId); assert.equal(oldInbox.state, 'queued');
  const summary = await f.a.getGroupSummary(f.g); assert.equal(summary.limit, 3); assert.equal(summary.used, 1);
  assert.equal(delivered.length, 0);
});

test('an overlapping unnamed heartbeat rebases rather than reverting a role rename', async t => {
  const f = await fixture(t); if (!f) return;
  let release; let started; const ready = new Promise(r => { started = r; });
  const barrier = new Promise(r => { release = r; }); t.after(() => release());
  const snapshot = f.a.snapshot.bind(f.a); let reads = 0;
  f.a.snapshot = async () => {
    const result = await snapshot();
    if (++reads === 1) { started(); await barrier; }
    return result;
  };
  const pending = f.a.heartbeat(); await ready;
  await f.a.heartbeat('test-reviewer');
  // Advance lastSeen past its previous millisecond, ensuring the stale write takes the CAS path.
  await new Promise(resolve => setTimeout(resolve, 2));
  release(); await pending;
  assert.ok(reads >= 3, 'The stale heartbeat must reread after a revision conflict');
  assert.equal(f.a.peer.displayName, 'test-reviewer');
  assert.equal((await f.b.peers(f.g)).find(p => p.id === f.a.peer.id).displayName, 'test-reviewer');
  await assert.rejects(f.a.heartbeat('\x1b[31minvalid'), /display name/i);
  assert.equal(f.a.peer.displayName, 'test-reviewer');
  assert.equal((await f.b.peers(f.g)).find(p => p.id === f.a.peer.id).displayName, 'test-reviewer');
});

test('concurrent sends preserve one identity and metadata reads cannot change allowance', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  await a.arm(g, 2);
  const messages = await Promise.all(Array.from({ length: 8 }, () => a.send({ toPeerId: b.peer.id, text: 'once' }, 'same-call')));
  assert.equal(new Set(messages.map(m => m.id)).size, 1);
  const r = await b.reserve(); await b.observe(r);
  assert.deepEqual(await b.reserve(), []);
  assert.equal((await a.getGroupSummary(g)).used, 1);
  const before = (await a.listMessages(g)).length;
  await assert.rejects(a.getGroupSummary({ ...g, authorityId: randomUUID() }), /authority/i);
  assert.equal((await a.listMessages(g)).length, before);
});

test('hard broker restart preserves attempted records, budgets and old inboxes', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  await a.arm(g, 2); const m = await a.send({ toPeerId: b.peer.id, text: 'uncertain' }, 'c');
  const batch = await b.reserve(); assert.equal(batch.length, 1); await f.stop('SIGKILL'); await f.start();
  const c = await connectBackend(f.config); t.after(() => c.close());
  assert.equal((await c.getGroupSummary(g)).remaining, 1);
  assert.equal((await c.listMessages(g))[0].state, 'attempted');
  await c.join(g, { sessionId: 'b', displayName: 'Bob' });
  assert.notEqual(c.peer.id, b.peer.id); assert.deepEqual(await c.reserve(), []);
  assert.equal((await c.readBody(g, m.id)).text, 'uncertain');
});

test('prune deletes only terminal inactive-sender records; pending and counters survive', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f; await a.arm(g, 2);
  const m = await a.send({ toPeerId: b.peer.id, text: 'terminal' }, 'one');
  await a.resolveMessage(g, m.id, 'canceled');
  const pending = await a.send({ toPeerId: b.peer.id, text: 'pending' }, 'two');
  assert.deepEqual(await a.prune(g), []);
  await a.leave(); assert.deepEqual(await b.prune(g), [m.id]);
  assert.deepEqual(await b.prune(g, true), [m.id]);
  assert.equal((await b.listMessages(g))[0].id, pending.id);
  assert.equal((await b.getGroupSummary(g)).limit, 2);
});

test('public reader exposes only summaries and never creates groups or grants allowance', async t => {
  const f = await fixture(t); if (!f) return;
  const { connectReader } = await createJiti(import.meta.url).import('../../src/messaging/public.ts');
  const reader = await connectReader(f.config); t.after(() => reader.close());
  assert.deepEqual(Object.keys(reader).sort(), ['close', 'getGroupSummary']);
  assert.equal((await reader.getGroupSummary(f.g)).remaining, 0);
  assert.equal(await reader.getGroupSummary({ ...f.g, id: randomUUID() }), null);
  await assert.rejects(reader.getGroupSummary({ ...f.g, authorityId: randomUUID() }), /authority/i);
  assert.equal((await f.a.listGroups()).length, 1);
});

test('missing publication is inspectable without inventing a body or deleting the reservation', async t => {
  const f = await fixture(t); if (!f) return;
  const { connect } = await import('@nats-io/transport-node');
  const { jetstreamManager } = await import('@nats-io/jetstream');
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  await f.a.arm(f.g, 1);
  const m = await f.a.send({ toPeerId: f.b.peer.id, text: 'body' }, 'missing');
  await (await jetstreamManager(nc)).streams.purge('PM_MESSAGES', { filter: `pm.message.${f.g.id}.${f.b.peer.id}.${m.id}` });
  assert.equal(await f.a.readBody(f.g, m.id), null);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'queued');
});

test('14 independent peer processes admit exactly 12, not merely at most 12', { timeout: 60000 }, async t => {
  const f = await brokerFixture(t); if (!f) return;
  const coordinator = await connectBackend(f.config, { initialize: true }); t.after(() => coordinator.close());
  const g = await coordinator.createGroup('race'); await coordinator.join(g, { sessionId: 'coordinator', displayName: 'Coordinator' });
  const participants = await Promise.all(Array.from({ length: 14 }, async (_, i) => {
    const child = fork(new URL('./helpers/contender.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const ready = once(child, 'message'); child.send({ action: 'join', config: f.config, g, i });
    const [peer] = await ready; assert.ok(peer.id, JSON.stringify(peer));
    return { child, peer };
  }));
  await coordinator.arm(g, 12);
  const sends = await Promise.all(participants.map(async ({ child }, i) => {
    const next = once(child, 'message');
    child.send({ action: 'send', toPeerId: participants[(i + 1) % participants.length].peer.id, key: `race-${i}` });
    return (await next)[0];
  }));
  assert.equal(sends.filter(result => result.messageId).length, 12, JSON.stringify(sends));
  assert.equal(sends.filter(result => /allowance/i.test(result.error ?? '')).length, 2, JSON.stringify(sends));
  const results = await Promise.all(participants.map(async ({ child }) => { const next = once(child, 'message'); child.send({ action: 'reserve' }); return (await next)[0]; }));
  assert.equal(results.filter(result => result.attemptId).length, 12);
  assert.equal(results.filter(result => result.error).length, 0, JSON.stringify(results));
  assert.equal((await coordinator.getGroupSummary(g)).used, 12);
  assert.equal((await coordinator.listMessages(g)).filter(message => message.state === 'queued').length, 0);
});
