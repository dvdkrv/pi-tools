import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as tcpConnect } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager, AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { createJiti } from 'jiti';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../../src/messaging/nats-backend.ts');
const consumerName = id => `peer_${id.replaceAll('-', '')}`;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function contenderRequest(child, message, timeoutMs = 5000) {
  const requestId = `${process.pid}-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Contender timeout for ${message.action}`)); }, timeoutMs);
    const onExit = (code, signal) => { cleanup(); reject(new Error(`Contender exited (${code ?? signal}) during ${message.action}`)); };
    const onMessage = response => { if (response?.requestId !== requestId) return; cleanup(); resolve(response); };
    const cleanup = () => { clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage); };
    child.on('exit', onExit); child.on('message', onMessage); child.send({ ...message, requestId });
  });
}
async function fixture(t) {
  const f = await brokerFixture(t); if (!f) return null;
  const a = await connectBackend(f.config, { initialize: true }); t.after(() => a.close());
  const b = await connectBackend(f.config); t.after(() => b.close());
  const g = await a.createGroup('faults'); await a.join(g, { sessionId: 'a', displayName: 'Alice' }); await b.join(g, { sessionId: 'b', displayName: 'Bob' });
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  return { ...f, a, b, g, nc, jsm: await jetstreamManager(nc) };
}

test('lost CAS acknowledgment consumes credit but returns no reservation or automatic refund', { timeout: 15000 }, async t => {
  const f = await fixture(t); if (!f) return;
  let drop = false; let dropped = false; const sockets = new Set();
  const proxy = createServer(client => {
    const upstream = tcpConnect({ host: '127.0.0.1', port: Number(new URL(f.config.server).port) });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => {}); upstream.on('error', () => {});
    client.pipe(upstream);
    upstream.on('data', chunk => {
      if (drop && /"stream"\s*:\s*"KV_PM_CONTROL"/.test(chunk.toString())) {
        dropped = true; drop = false; client.destroy(); upstream.destroy();
      } else client.write(chunk);
    });
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(r => proxy.close(r)); });
  const receiver = await connectBackend({ ...f.config, server: `nats://127.0.0.1:${proxy.address().port}` }); t.after(() => receiver.close());
  await receiver.join(f.g, { sessionId: 'proxied', displayName: 'Proxied' });
  await f.a.arm(f.g, 2); await f.a.send({ kind: 'notice', toPeerId: receiver.peer.id, text: 'uncertain' }, 'lost-ack');
  drop = true;
  await assert.rejects(receiver.reserve(), /uncertain/i); assert.equal(dropped, true);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'attempted');
  await assert.rejects(receiver.reserve(), /unavailable|join/i);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
});

test('broker replay of an observed message is consumed without a second Pi reservation', async t => {
  const f = await fixture(t); if (!f) return;
  const input = { kind: 'notice', toPeerId: f.b.peer.id, text: 'once' };
  await f.jsm.streams.update('PM_MESSAGES', { duplicate_window: 100_000_000 });
  await f.a.arm(f.g, 3);
  await Promise.all(Array.from({ length: 5 }, () => f.a.send(input, 'same')));
  await new Promise(r => setTimeout(r, 150)); // Deliberately exceed the broker deduplication window.
  await f.a.send(input, 'same');
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.messages, 1, 'expected-subject-sequence prevents duplicate publication');
  const r = await f.b.reserve(); await f.b.observe(r);
  const old = await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id));
  await f.jsm.consumers.delete('PM_MESSAGES', old.name);
  await f.jsm.consumers.add('PM_MESSAGES', { durable_name: old.name, filter_subject: old.config.filter_subject, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_ack_pending: 8 });
  assert.deepEqual(await f.b.reserve(), []);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
  assert.ok((await f.jsm.consumers.info('PM_MESSAGES', old.name)).delivered.stream_seq > 0, 'broker really replayed the body');
});

test('a body published after the reservation high-water waits for the next batch', { timeout: 10000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1);
  const publicationStarted = deferred(); const releasePublication = deferred();
  const publish = f.a.js.publish.bind(f.a.js);
  f.a.js.publish = async (...args) => { publicationStarted.resolve(); await releasePublication.promise; return publish(...args); };
  const sending = f.a.send({ kind: 'notice', toPeerId: f.b.peer.id, text: 'after boundary' }, 'after-boundary');
  await publicationStarted.promise;
  const streamInfo = f.b.jsm.streams.info.bind(f.b.jsm.streams); let highWaterReads = 0;
  f.b.jsm.streams.info = async name => { if (name === 'PM_MESSAGES') highWaterReads++; return streamInfo(name); };
  const fetch = f.b.consumer.fetch.bind(f.b.consumer); const fetchStarted = deferred(); const releaseFetch = deferred();
  f.b.consumer.fetch = async options => {
    const messages = await fetch(options); const iterator = messages[Symbol.asyncIterator](); let first = true;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const pending = iterator.next();
          if (first) { first = false; fetchStarted.resolve(); await releaseFetch.promise; }
          return pending;
        },
        return: value => iterator.return?.(value),
      }),
      close: () => messages.close(),
    };
  };
  const reserving = f.b.reserve(); await fetchStarted.promise;
  releasePublication.resolve(); await sending; releaseFetch.resolve();
  assert.deepEqual(await reserving, []);
  assert.equal(highWaterReads, 1, 'reservation must capture one stream sequence boundary');
  await new Promise(resolve => setTimeout(resolve, 1100)); // The backend deliberately NAKs post-boundary work for one second.
  const next = await f.b.reserve(); assert.equal(next.length, 1); assert.equal(next[0].envelope.text, 'after boundary');
});

test('a pre-boundary body without ledger metadata is acknowledged as stale', async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1);
  const message = await f.a.send({ kind: 'notice', toPeerId: f.b.peer.id, text: 'orphan' }, 'orphan');
  const { state, revision } = await f.b.snapshot(); delete state.messages[message.id];
  await f.b.kv.update('state', JSON.stringify(state), revision);
  assert.deepEqual(await f.b.reserve(), []);
  const info = await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id));
  assert.ok(info.ack_floor.stream_seq > 0, 'stale body must not be NAKed forever');
});

test('a pause committed before the admission CAS prevents the whole batch', { timeout: 10000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1); await f.a.send({ kind: 'notice', toPeerId: f.b.peer.id, text: 'wait' }, 'paused');
  const snapshot = f.b.snapshot.bind(f.b); let reads = 0; let release; let blocked;
  const waiting = new Promise(resolve => { release = resolve; }); const reached = new Promise(resolve => { blocked = resolve; });
  f.b.snapshot = async () => { const value = await snapshot(); if (++reads === 2) { blocked(); await waiting; } return value; };
  const pulling = f.b.reserve(); await reached;
  await f.a.pause(f.g); release();
  assert.deepEqual(await pulling, []); assert.equal((await f.a.getGroupSummary(f.g)).used, 0);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'queued');
});

test('leave during join invalidates the new identity before a consumer can activate', async t => {
  const f = await fixture(t); if (!f) return;
  await f.b.leave();
  const joining = f.b.join(f.g, { sessionId: 'late', displayName: 'Late' });
  await f.b.leave(); await assert.rejects(joining, /canceled/i);
  assert.equal(f.b.peer, undefined);
  assert.equal((await f.b.peers(f.g)).some(p => p.displayName === 'Late' && p.active), false);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 1);
});

test('rotated lease fences every old process mutation without deactivating the resumed peer', { timeout: 20000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const child = fork(new URL('./helpers/lease-contender.mjs', import.meta.url), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.connected) await contenderRequest(child, { action: 'close' }, 2000).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const initialized = await contenderRequest(child, { action: 'init', config: f.config, group: f.g, sessionId: 'old-child', displayName: 'Old Child' });
  assert.equal(initialized.ok, true); const old = initialized.value;
  assert.equal(Object.hasOwn(old, 'leaseId'), false);
  await f.a.arm(f.g, 2);
  const attempted = await f.a.send({ kind: 'notice', toPeerId: old.id, text: 'attempted before rotation' }, 'before-rotation');
  assert.deepEqual((await contenderRequest(child, { action: 'reserve' })).value.messageIds, [attempted.id]);

  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[old.id].lastSeen = Date.now() - 31_000; await kv.update('state', JSON.stringify(state), entry.revision);
  const winner = await connectBackend(f.config); t.after(() => winner.close());
  await winner.resume(f.g, old.id, old.sessionId);

  for (const action of ['heartbeat', 'rename', 'send', 'reserve', 'observe', 'suspend', 'leave']) {
    const response = await contenderRequest(child, { action, toPeerId: f.a.peer.id });
    assert.equal(response.ok, false, `${action} unexpectedly succeeded`);
    assert.equal(response.code, 'participation', `${action} did not fail on its stale lease`);
  }
  await winner.heartbeat();
  const peer = (await f.a.peers(f.g)).find(candidate => candidate.id === old.id);
  assert.equal(peer.active, true); assert.equal(peer.suspended, false); assert.equal(peer.displayName, old.displayName);
  assert.equal((await f.a.listMessages(f.g)).some(message => message.requestKey === 'old-process-send'), false);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
});

test('held batch pull under a rotated lease is not acknowledged and redelivers in order', { timeout: 20000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const senders = [f.a];
  for (let index = 1; index < 3; index++) {
    const sender = await connectBackend(f.config); t.after(() => sender.close());
    await sender.join(f.g, { sessionId: `held-sender-${index}`, displayName: `Held Sender ${index}` }); senders.push(sender);
  }
  await f.a.arm(f.g, 3);
  const sent = [];
  for (let index = 0; index < senders.length; index++) {
    sent.push(await senders[index].send({ kind: 'notice', toPeerId: f.b.peer.id, text: `held-${index}` }, `held-${index}`));
  }

  const originalSnapshot = f.b.snapshot.bind(f.b); let reads = 0;
  const blocked = deferred(); const atAdmission = deferred(); t.after(() => blocked.resolve());
  f.b.snapshot = async () => {
    const snapshot = await originalSnapshot();
    if (++reads === 2) { atAdmission.resolve(); await blocked.promise; }
    return snapshot;
  };
  const pulling = f.b.reserve(); await atAdmission.promise;
  const before = await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id));
  assert.equal(before.ack_floor.stream_seq, 0, 'held messages must not be acknowledged before admission');

  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[f.b.peer.id].lastSeen = Date.now() - 31_000; await kv.update('state', JSON.stringify(state), entry.revision);
  const winner = await connectBackend(f.config); t.after(() => winner.close());
  await winner.resume(f.g, f.b.peer.id, f.b.peer.sessionId);
  blocked.resolve(); await assert.rejects(pulling, /lease|current|resume/i);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 0);
  assert.deepEqual((await f.a.listMessages(f.g)).sort((a, b) => a.sequence - b.sequence).map(message => [message.id, message.state]), sent.map(message => [message.id, 'queued']));
  assert.equal((await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id))).ack_floor.stream_seq, 0);
  await f.b.close();

  let batch = []; const deadline = Date.now() + 8000;
  while (batch.length === 0 && Date.now() < deadline) batch = await winner.reserve();
  assert.deepEqual(batch.map(item => item.message.id), sent.map(message => message.id));
  assert.equal((await winner.getGroupSummary(f.g)).used, 3);
});

test('prune reclaims a durable consumer orphaned after leave metadata committed', async t => {
  const f = await fixture(t); if (!f) return;
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[f.b.peer.id].active = false; state.peers[f.b.peer.id].suspended = false;
  state.peers[f.b.peer.id].endedAt = Date.now(); state.peers[f.b.peer.id].endReason = 'leave';
  state.routes = Object.fromEntries(Object.entries(state.routes).filter(([, route]) => route.fromPeerId !== f.b.peer.id && route.toPeerId !== f.b.peer.id));
  await kv.update('state', JSON.stringify(state), entry.revision);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 2);
  await f.a.prune(f.g, true);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 1);
});

test('send maintenance removes old terminal inactive-sender history without removing pending work or credits', async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 2);
  const terminal = await f.a.send({ kind: 'notice', toPeerId: f.b.peer.id, text: 'old' }, 'old');
  await f.a.resolveMessage(f.g, terminal.id, 'canceled');
  const pending = await f.a.send({ kind: 'notice', toPeerId: f.b.peer.id, text: 'retain' }, 'pending');
  await f.a.leave();
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.messages[terminal.id].terminalAt = Date.now() - 8 * 86400000; await kv.update('state', JSON.stringify(state), entry.revision);
  await f.a.join(f.g, { sessionId: 'fresh', displayName: 'Fresh' });
  await f.b.send({ kind: 'notice', toPeerId: f.a.peer.id, text: 'new' }, 'maintenance');
  const all = await f.b.listMessages(f.g);
  assert.equal(all.some(m => m.id === terminal.id), false);
  assert.equal(all.some(m => m.id === pending.id), true);
  assert.equal((await f.b.getGroupSummary(f.g)).used, 0);
});
